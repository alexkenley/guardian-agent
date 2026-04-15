import { createHash } from 'node:crypto';
import type { AuditLog } from '../guardian/audit-log.js';
import { stripInvisibleChars } from '../guardian/input-sanitizer.js';
import type { AssistantJobTracker } from './assistant-jobs.js';
import {
  classifyMemoryEntrySource,
  type AgentMemoryStore,
  type MemoryArtifactClass,
  type MemoryEntry,
  type MemoryLifecycleClass,
  type StoredMemoryEntry,
} from './agent-memory-store.js';

export type MemoryMutationIntent = 'assistant_save' | 'operator_curate' | 'context_flush';
export type MemoryMutationScope = 'global' | 'code_session';
export type MemoryMutationAction = 'created' | 'updated' | 'noop';
export type MemoryMutationReason =
  | 'new_entry'
  | 'explicit_update'
  | 'exact_duplicate'
  | 'canonical_match'
  | 'slug_match'
  | 'near_duplicate';

export interface MemoryMutationTarget {
  scope: MemoryMutationScope;
  scopeId: string;
  store: AgentMemoryStore;
  auditAgentId: string;
}

export interface PersistMemoryEntryInput {
  target: MemoryMutationTarget;
  intent: MemoryMutationIntent;
  entry: MemoryEntry;
  actor?: string;
  existingEntryId?: string;
  runMaintenance?: boolean;
}

export interface MemoryScopeHygieneResult {
  reviewedEntries: number;
  archivedExactDuplicates: number;
  archivedNearDuplicates: number;
  archivedStaleSystemEntries: number;
  changed: boolean;
}

export interface PersistMemoryEntryResult {
  action: MemoryMutationAction;
  reason: MemoryMutationReason;
  entry: StoredMemoryEntry;
  matchedEntryId?: string;
  maintenance?: MemoryScopeHygieneResult;
}

export interface MemoryMutationServiceOptions {
  auditLog?: AuditLog;
  jobTracker?: AssistantJobTracker;
  now?: () => number;
}

export interface RunMemoryScopeMaintenanceInput {
  target: MemoryMutationTarget;
  maintenanceType?: 'consolidation' | 'idle_sweep';
  triggerEntryId?: string;
  detail?: string;
  actor?: string;
}

const PROFILE_CATEGORY_RE = /^(preferences?|decisions?|facts?|instructions?|project notes?|runbooks?)$/i;
const SIMILARITY_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'has',
  'have',
  'i',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'our',
  'that',
  'the',
  'their',
  'this',
  'to',
  'we',
  'with',
  'you',
  'your',
]);

function normalizeInlineText(value: string | undefined): string {
  return stripInvisibleChars(String(value ?? '')).replace(/\s+/g, ' ').trim();
}

function slugifyMemoryValue(value: string | undefined): string {
  return normalizeInlineText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeSimilarityText(value: string | undefined): string {
  return normalizeInlineText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeSimilarityText(value: string | undefined): string[] {
  return normalizeSimilarityText(value)
    .split(' ')
    .filter((token) => token.length >= 3 && !SIMILARITY_STOPWORDS.has(token));
}

function buildSimilaritySet(parts: Array<string | undefined>): Set<string> {
  return new Set(parts.flatMap((value) => tokenizeSimilarityText(value)));
}

function intersectionSize(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const token of left) {
    if (right.has(token)) count += 1;
  }
  return count;
}

function computeContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function pickNewestTimestamp(entry: StoredMemoryEntry): number {
  const artifactTimestamp = Date.parse(entry.artifact?.updatedAt ?? '');
  if (Number.isFinite(artifactTimestamp)) {
    return artifactTimestamp;
  }
  const createdAtTimestamp = Date.parse(entry.createdAt);
  return Number.isFinite(createdAtTimestamp) ? createdAtTimestamp : 0;
}

function sourceClassPriority(sourceClass: MemoryArtifactClass): number {
  switch (sourceClass) {
    case 'operator_curated':
      return 3;
    case 'canonical':
      return 2;
    case 'linked_output':
      return 1;
    default:
      return 0;
  }
}

function addDaysIso(fromMs: number, days: number): string {
  const base = Number.isFinite(fromMs) ? fromMs : Date.now();
  return new Date(base + days * 24 * 60 * 60 * 1000).toISOString();
}

function parseReferenceTimeMs(value: string | undefined, fallback: number): number {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
}

export class MemoryMutationService {
  private readonly auditLog?: AuditLog;
  private readonly jobTracker?: AssistantJobTracker;
  private readonly now: () => number;

  constructor(options: MemoryMutationServiceOptions = {}) {
    this.auditLog = options.auditLog;
    this.jobTracker = options.jobTracker;
    this.now = options.now ?? Date.now;
  }

  persist(input: PersistMemoryEntryInput): PersistMemoryEntryResult {
    const prepared = this.prepareEntry(input.entry, input.intent, input.actor);
    const { target } = input;
    const entries = target.store.getEntries(target.scopeId, true);
    const activeEntries = entries.filter((entry) => entry.status === 'active');
    const exactDuplicate = activeEntries.find((entry) => entry.contentHash === computeContentHash(prepared.content));

    if (input.existingEntryId) {
      const updated = target.store.updateEntry(target.scopeId, input.existingEntryId, {
        ...this.buildUpdatePatch(prepared),
        status: 'active',
      });
      return {
        action: 'updated',
        reason: 'explicit_update',
        entry: updated,
        maintenance: this.maybeRunMaintenance(input, updated),
      };
    }

    const canonicalKey = normalizeInlineText(prepared.artifact?.canonicalKey ?? '').toLowerCase();
    if (canonicalKey) {
      const canonicalMatch = this.findLifecycleCandidate(entries, (entry) => (
        normalizeInlineText(entry.artifact?.canonicalKey ?? '').toLowerCase() === canonicalKey
      ));
      if (canonicalMatch) {
        const action = canonicalMatch.status === 'active' && canonicalMatch.contentHash === computeContentHash(prepared.content)
          ? 'noop'
          : 'updated';
        if (action === 'noop') {
          return {
            action,
            reason: 'canonical_match',
            entry: canonicalMatch,
            matchedEntryId: canonicalMatch.id,
          };
        }
        const updated = target.store.updateEntry(target.scopeId, canonicalMatch.id, {
          ...this.buildUpdatePatch(prepared),
          status: 'active',
        });
        return {
          action: 'updated',
          reason: 'canonical_match',
          entry: updated,
          matchedEntryId: canonicalMatch.id,
          maintenance: this.maybeRunMaintenance(input, updated),
        };
      }
    }

    const sourceClass = classifyMemoryEntrySource(prepared);
    const slug = normalizeInlineText(prepared.artifact?.slug ?? '').toLowerCase();
    if (sourceClass === 'operator_curated' && slug) {
      const slugMatch = this.findLifecycleCandidate(entries, (entry) => (
        classifyMemoryEntrySource(entry) === 'operator_curated'
          && normalizeInlineText(entry.artifact?.slug ?? '').toLowerCase() === slug
      ));
      if (slugMatch) {
        const action = slugMatch.status === 'active' && slugMatch.contentHash === computeContentHash(prepared.content)
          ? 'noop'
          : 'updated';
        if (action === 'noop') {
          return {
            action,
            reason: 'slug_match',
            entry: slugMatch,
            matchedEntryId: slugMatch.id,
          };
        }
        const updated = target.store.updateEntry(target.scopeId, slugMatch.id, {
          ...this.buildUpdatePatch(prepared),
          status: 'active',
        });
        return {
          action: 'updated',
          reason: 'slug_match',
          entry: updated,
          matchedEntryId: slugMatch.id,
          maintenance: this.maybeRunMaintenance(input, updated),
        };
      }
    }

    if (exactDuplicate) {
      return {
        action: 'noop',
        reason: 'exact_duplicate',
        entry: exactDuplicate,
        matchedEntryId: exactDuplicate.id,
      };
    }

    const nearDuplicate = this.findNearDuplicateCandidate(activeEntries, prepared);
    if (nearDuplicate) {
      if (this.preferExistingCandidate(nearDuplicate, prepared)) {
        return {
          action: 'noop',
          reason: 'near_duplicate',
          entry: nearDuplicate,
          matchedEntryId: nearDuplicate.id,
        };
      }
      const updated = target.store.updateEntry(target.scopeId, nearDuplicate.id, {
        ...this.buildUpdatePatch(prepared),
        status: 'active',
      });
      return {
        action: 'updated',
        reason: 'near_duplicate',
        entry: updated,
        matchedEntryId: nearDuplicate.id,
        maintenance: this.maybeRunMaintenance(input, updated),
      };
    }

    const created = target.store.append(target.scopeId, prepared);
    return {
      action: 'created',
      reason: 'new_entry',
      entry: created,
      maintenance: this.maybeRunMaintenance(input, created),
    };
  }

  private prepareEntry(entry: MemoryEntry, intent: MemoryMutationIntent, actor: string | undefined): MemoryEntry {
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const createdAt = normalizeInlineText(entry.createdAt) || nowIso.slice(0, 10);
    const sourceClass = classifyMemoryEntrySource(entry);
    const memoryClass = this.inferMemoryClass(entry, sourceClass);
    const staleAfterDays = this.inferStaleAfterDays(entry, sourceClass, memoryClass);
    const title = normalizeInlineText(entry.artifact?.title);
    const slug = sourceClass === 'operator_curated'
      ? (slugifyMemoryValue(entry.artifact?.slug || title) || undefined)
      : (slugifyMemoryValue(entry.artifact?.slug) || undefined);
    const canonicalKey = normalizeInlineText(entry.artifact?.canonicalKey)
      || this.deriveCanonicalKey(entry, memoryClass, title, slug);
    const reviewAnchor = parseReferenceTimeMs(entry.artifact?.updatedAt || createdAt, nowMs);
    const retrievalHints = this.buildRetrievalHints(entry, title);

    return {
      ...entry,
      createdAt,
      createdByPrincipal: entry.createdByPrincipal ?? actor,
      artifact: {
        ...(entry.artifact ?? {}),
        sourceClass,
        kind: entry.artifact?.kind ?? 'memory_entry',
        memoryClass,
        ...(title ? { title } : {}),
        ...(slug ? { slug } : {}),
        ...(canonicalKey ? { canonicalKey } : {}),
        ...(retrievalHints.length > 0 ? { retrievalHints } : {}),
        ...(sourceClass === 'derived' ? { refreshable: entry.artifact?.refreshable ?? true } : {}),
        staleAfterDays,
        lastReviewedAt: intent === 'operator_curate'
          ? nowIso
          : (entry.artifact?.lastReviewedAt ?? undefined),
        nextReviewAt: entry.artifact?.nextReviewAt ?? addDaysIso(reviewAnchor, staleAfterDays),
        updatedAt: entry.artifact?.updatedAt ?? nowIso,
        updatedByPrincipal: entry.artifact?.updatedByPrincipal ?? actor,
        ...(entry.artifact?.changeReason ? { changeReason: entry.artifact.changeReason } : {}),
      },
    };
  }

  private buildUpdatePatch(entry: MemoryEntry): Partial<MemoryEntry> {
    return {
      content: entry.content,
      summary: entry.summary,
      category: entry.category,
      sourceType: entry.sourceType,
      trustLevel: entry.trustLevel,
      status: entry.status,
      expiresAt: entry.expiresAt,
      tags: entry.tags ? [...entry.tags] : undefined,
      provenance: entry.provenance ? { ...entry.provenance } : undefined,
      artifact: entry.artifact ? { ...entry.artifact } : undefined,
    };
  }

  private inferMemoryClass(entry: MemoryEntry, sourceClass: MemoryArtifactClass): MemoryLifecycleClass {
    if (entry.artifact?.memoryClass) {
      return entry.artifact.memoryClass;
    }
    if (sourceClass === 'operator_curated') {
      return 'profile';
    }
    if (entry.tags?.includes('context_flush') || entry.sourceType === 'system' || sourceClass === 'derived') {
      return 'collection';
    }
    if (PROFILE_CATEGORY_RE.test(entry.category?.trim() ?? '')) {
      return 'profile';
    }
    return 'collection';
  }

  private inferStaleAfterDays(
    entry: MemoryEntry,
    sourceClass: MemoryArtifactClass,
    memoryClass: MemoryLifecycleClass,
  ): number {
    if (typeof entry.artifact?.staleAfterDays === 'number' && Number.isFinite(entry.artifact.staleAfterDays)) {
      return Math.max(1, Math.round(entry.artifact.staleAfterDays));
    }
    if (entry.tags?.includes('context_flush') || sourceClass === 'derived') {
      return 30;
    }
    if (sourceClass === 'linked_output') {
      return 90;
    }
    return memoryClass === 'profile' ? 180 : 120;
  }

  private deriveCanonicalKey(
    entry: MemoryEntry,
    memoryClass: MemoryLifecycleClass,
    title: string,
    slug: string | undefined,
  ): string | undefined {
    if (classifyMemoryEntrySource(entry) === 'operator_curated' && slug) {
      return `wiki:${slug}`;
    }
    if (memoryClass !== 'profile' || !title) {
      return undefined;
    }
    const category = slugifyMemoryValue(entry.category || 'general');
    const titleSlug = slugifyMemoryValue(title);
    return category && titleSlug ? `${category}:${titleSlug}` : undefined;
  }

  private buildRetrievalHints(entry: MemoryEntry, title: string): string[] {
    const hints = [
      ...(entry.artifact?.retrievalHints ?? []),
      title,
      entry.category,
      ...(entry.tags ?? []),
    ]
      .map((value) => normalizeInlineText(value))
      .filter(Boolean);
    return [...new Set(hints)].slice(0, 12);
  }

  private findLifecycleCandidate(
    entries: StoredMemoryEntry[],
    match: (entry: StoredMemoryEntry) => boolean,
  ): StoredMemoryEntry | undefined {
    return entries
      .filter(match)
      .slice()
      .sort((left, right) => {
        if (left.status !== right.status) {
          return left.status === 'active' ? -1 : 1;
        }
        const timeDelta = pickNewestTimestamp(right) - pickNewestTimestamp(left);
        if (timeDelta !== 0) return timeDelta;
        return right.id.localeCompare(left.id);
      })[0];
  }

  private findNearDuplicateCandidate(
    activeEntries: StoredMemoryEntry[],
    incoming: MemoryEntry,
  ): StoredMemoryEntry | undefined {
    if (incoming.artifact?.memoryClass !== 'profile') {
      return undefined;
    }

    const incomingSourceClass = classifyMemoryEntrySource(incoming);
    const incomingCategory = normalizeInlineText(incoming.category).toLowerCase();
    const incomingTitleSlug = slugifyMemoryValue(incoming.artifact?.title);
    const incomingTokens = buildSimilaritySet([
      incoming.content,
      incoming.summary,
      incoming.artifact?.title,
    ]);
    if (incomingTokens.size < 3) {
      return undefined;
    }

    let bestCandidate: { entry: StoredMemoryEntry; coverage: number; overlap: number } | null = null;
    for (const candidate of activeEntries) {
      if (classifyMemoryEntrySource(candidate) !== incomingSourceClass) continue;
      if (candidate.artifact?.memoryClass !== 'profile') continue;

      const candidateCategory = normalizeInlineText(candidate.category).toLowerCase();
      const candidateTitleSlug = slugifyMemoryValue(candidate.artifact?.title);
      const categoryMatch = Boolean(incomingCategory && candidateCategory && incomingCategory === candidateCategory);
      const titleMatch = Boolean(incomingTitleSlug && candidateTitleSlug && incomingTitleSlug === candidateTitleSlug);
      if (!categoryMatch && !titleMatch) continue;

      const candidateTokens = buildSimilaritySet([
        candidate.content,
        candidate.summary,
        candidate.artifact?.title,
      ]);
      const sharedTokens = intersectionSize(incomingTokens, candidateTokens);
      if (sharedTokens < 3) continue;

      const overlap = sharedTokens / Math.max(incomingTokens.size, candidateTokens.size);
      const coverage = sharedTokens / Math.min(incomingTokens.size, candidateTokens.size);
      const accepted = titleMatch
        ? coverage >= 0.72
        : (categoryMatch && coverage >= 0.9 && overlap >= 0.72);
      if (!accepted) continue;

      if (!bestCandidate || coverage > bestCandidate.coverage || (coverage === bestCandidate.coverage && overlap > bestCandidate.overlap)) {
        bestCandidate = { entry: candidate, coverage, overlap };
      }
    }

    return bestCandidate?.entry;
  }

  private preferExistingCandidate(existing: StoredMemoryEntry, incoming: MemoryEntry): boolean {
    const existingScore = this.estimateSignalScore(existing.content, existing.summary, existing.artifact?.title, existing.tags);
    const incomingScore = this.estimateSignalScore(incoming.content, incoming.summary, incoming.artifact?.title, incoming.tags);
    return existingScore >= incomingScore;
  }

  private estimateSignalScore(
    content: string | undefined,
    summary: string | undefined,
    title: string | undefined,
    tags: string[] | undefined,
  ): number {
    return normalizeInlineText(content).length
      + normalizeInlineText(summary).length * 2
      + normalizeInlineText(title).length * 2
      + (Array.isArray(tags) ? tags.length * 12 : 0);
  }

  private maybeRunMaintenance(
    input: PersistMemoryEntryInput,
    entry: StoredMemoryEntry,
  ): MemoryScopeHygieneResult | undefined {
    if (input.runMaintenance === false) {
      return undefined;
    }
    return this.runScopeHygiene(input.target, entry);
  }

  runMaintenanceForScope(input: RunMemoryScopeMaintenanceInput): MemoryScopeHygieneResult {
    const maintenanceType = input.maintenanceType ?? 'idle_sweep';
    const detail = input.detail?.trim();
    const actor = input.actor?.trim();
    const started = this.jobTracker?.start({
      type: `memory_hygiene.${maintenanceType}`,
      source: 'system',
      detail: detail || `Memory hygiene scan for ${input.target.scope === 'global' ? 'global memory' : `code session ${input.target.scopeId}`}`,
      metadata: {
        maintenance: {
          kind: 'memory_hygiene',
          maintenanceType,
          artifact: 'memory_entry',
          bounded: true,
          scope: input.target.scope,
          scopeId: input.target.scopeId,
          ...(input.triggerEntryId ? { triggerEntryId: input.triggerEntryId } : {}),
        },
      },
    });

    try {
      const result = this.performScopeHygiene(input.target);
      const summary = this.describeHygieneResult(input.target, result);
      this.jobTracker?.succeed(started?.id ?? '', { detail: detail || summary });
      this.auditLog?.record({
        type: `memory_hygiene.${maintenanceType}`,
        severity: 'info',
        agentId: input.target.auditAgentId,
        controller: 'MemoryMutationService',
        details: {
          scope: input.target.scope,
          scopeId: input.target.scopeId,
          ...(actor ? { actor } : {}),
          ...(input.triggerEntryId ? { entryId: input.triggerEntryId } : {}),
          reviewedEntries: result.reviewedEntries,
          archivedExactDuplicates: result.archivedExactDuplicates,
          archivedNearDuplicates: result.archivedNearDuplicates,
          archivedStaleSystemEntries: result.archivedStaleSystemEntries,
          summary,
          ...(detail ? { detail } : {}),
        },
      });
      return result;
    } catch (err) {
      this.jobTracker?.fail(started?.id ?? '', err, {
        detail: detail || `Memory hygiene failed for ${input.target.scope === 'global' ? 'global memory' : `code session ${input.target.scopeId}`}.`,
      });
      throw err;
    }
  }

  private runScopeHygiene(
    target: MemoryMutationTarget,
    triggerEntry: StoredMemoryEntry,
  ): MemoryScopeHygieneResult {
    return this.runMaintenanceForScope({
      target,
      maintenanceType: 'consolidation',
      triggerEntryId: triggerEntry.id,
    });
  }

  private performScopeHygiene(target: MemoryMutationTarget): MemoryScopeHygieneResult {
    const entries = target.store.getEntries(target.scopeId, true);
    const activeEntries = entries.filter((entry) => entry.status === 'active');
    const archivedIds = new Set<string>();
    let archivedExactDuplicates = 0;
    let archivedNearDuplicates = 0;
    let archivedStaleSystemEntries = 0;

    const duplicateGroups = new Map<string, StoredMemoryEntry[]>();
    for (const entry of activeEntries) {
      const list = duplicateGroups.get(entry.contentHash) ?? [];
      list.push(entry);
      duplicateGroups.set(entry.contentHash, list);
    }
    for (const group of duplicateGroups.values()) {
      if (group.length < 2) continue;
      const keeper = group
        .slice()
        .sort((left, right) => {
          const sourcePriorityDelta = sourceClassPriority(classifyMemoryEntrySource(right))
            - sourceClassPriority(classifyMemoryEntrySource(left));
          if (sourcePriorityDelta !== 0) return sourcePriorityDelta;
          return pickNewestTimestamp(right) - pickNewestTimestamp(left);
        })[0];
      for (const duplicate of group) {
        if (!keeper || duplicate.id === keeper.id) continue;
        target.store.archiveEntry(target.scopeId, duplicate.id, {
          archivedByPrincipal: 'memory-hygiene',
          reason: `Archived exact duplicate of '${this.describeEntryTitle(keeper)}'.`,
        });
        archivedIds.add(duplicate.id);
        archivedExactDuplicates += 1;
      }
    }

    const remainingActive = target.store
      .getEntries(target.scopeId, false)
      .filter((entry) => !archivedIds.has(entry.id));

    for (const entry of remainingActive) {
      if (!this.isAutoManagedStaleCandidate(entry)) continue;
      if (!this.isStale(entry)) continue;
      target.store.archiveEntry(target.scopeId, entry.id, {
        archivedByPrincipal: 'memory-hygiene',
        reason: `Archived stale system-managed memory '${this.describeEntryTitle(entry)}'.`,
      });
      archivedIds.add(entry.id);
      archivedStaleSystemEntries += 1;
    }

    const nearDuplicateCandidates = target.store
      .getEntries(target.scopeId, false)
      .filter((entry) => !archivedIds.has(entry.id) && this.isCollectionNearDuplicateCandidate(entry));
    const keepers: StoredMemoryEntry[] = [];
    for (const candidate of nearDuplicateCandidates) {
      const candidateTokens = buildSimilaritySet([candidate.content, candidate.summary, candidate.artifact?.title]);
      if (candidateTokens.size < 3) {
        keepers.push(candidate);
        continue;
      }
      const duplicateOf = keepers.find((keeper) => this.isNearDuplicateCollectionEntry(candidate, keeper, candidateTokens));
      if (!duplicateOf) {
        keepers.push(candidate);
        continue;
      }
      target.store.archiveEntry(target.scopeId, candidate.id, {
        archivedByPrincipal: 'memory-hygiene',
        reason: `Archived redundant system-managed memory near duplicate of '${this.describeEntryTitle(duplicateOf)}'.`,
      });
      archivedIds.add(candidate.id);
      archivedNearDuplicates += 1;
    }

    return {
      reviewedEntries: entries.length,
      archivedExactDuplicates,
      archivedNearDuplicates,
      archivedStaleSystemEntries,
      changed: archivedExactDuplicates + archivedNearDuplicates + archivedStaleSystemEntries > 0,
    };
  }

  private describeEntryTitle(entry: StoredMemoryEntry): string {
    return normalizeInlineText(entry.artifact?.title)
      || normalizeInlineText(entry.summary).slice(0, 72)
      || normalizeInlineText(entry.content).slice(0, 72)
      || entry.category?.trim()
      || entry.id;
  }

  private describeHygieneResult(target: MemoryMutationTarget, result: MemoryScopeHygieneResult): string {
    const scopeLabel = target.scope === 'global' ? 'global memory' : `code session ${target.scopeId}`;
    if (!result.changed) {
      return `Memory hygiene reviewed ${result.reviewedEntries} entr${result.reviewedEntries === 1 ? 'y' : 'ies'} in ${scopeLabel}; no consolidation required.`;
    }
    return `Memory hygiene consolidated ${scopeLabel}: archived ${result.archivedExactDuplicates} exact duplicate entr${result.archivedExactDuplicates === 1 ? 'y' : 'ies'}, ${result.archivedNearDuplicates} near duplicate entr${result.archivedNearDuplicates === 1 ? 'y' : 'ies'}, and ${result.archivedStaleSystemEntries} stale system-managed entr${result.archivedStaleSystemEntries === 1 ? 'y' : 'ies'}.`;
  }

  private isAutoManagedStaleCandidate(entry: StoredMemoryEntry): boolean {
    const sourceClass = classifyMemoryEntrySource(entry);
    return entry.tags?.includes('context_flush') === true
      || sourceClass === 'derived'
      || (entry.sourceType === 'system' && entry.artifact?.refreshable === true);
  }

  private isStale(entry: StoredMemoryEntry): boolean {
    const nowMs = this.now();
    const nextReviewAt = Date.parse(entry.artifact?.nextReviewAt ?? '');
    if (Number.isFinite(nextReviewAt)) {
      return nextReviewAt <= nowMs;
    }
    const staleAfterDays = typeof entry.artifact?.staleAfterDays === 'number'
      ? entry.artifact.staleAfterDays
      : (entry.tags?.includes('context_flush') ? 30 : 180);
    const referenceMs = parseReferenceTimeMs(entry.artifact?.updatedAt || entry.createdAt, nowMs);
    return referenceMs + staleAfterDays * 24 * 60 * 60 * 1000 <= nowMs;
  }

  private isCollectionNearDuplicateCandidate(entry: StoredMemoryEntry): boolean {
    return entry.artifact?.memoryClass === 'collection'
      && (
        entry.tags?.includes('context_flush') === true
        || classifyMemoryEntrySource(entry) === 'derived'
      );
  }

  private isNearDuplicateCollectionEntry(
    candidate: StoredMemoryEntry,
    keeper: StoredMemoryEntry,
    candidateTokens: Set<string>,
  ): boolean {
    const candidateCategory = normalizeInlineText(candidate.category).toLowerCase();
    const keeperCategory = normalizeInlineText(keeper.category).toLowerCase();
    if (candidateCategory && keeperCategory && candidateCategory !== keeperCategory) {
      return false;
    }
    const candidateSourceClass = classifyMemoryEntrySource(candidate);
    const keeperSourceClass = classifyMemoryEntrySource(keeper);
    if (candidateSourceClass !== keeperSourceClass) {
      return false;
    }
    const keeperTokens = buildSimilaritySet([keeper.content, keeper.summary, keeper.artifact?.title]);
    const sharedTokens = intersectionSize(candidateTokens, keeperTokens);
    if (sharedTokens < 3) {
      return false;
    }
    const overlap = sharedTokens / Math.max(candidateTokens.size, keeperTokens.size);
    const coverage = sharedTokens / Math.min(candidateTokens.size, keeperTokens.size);
    return coverage >= 0.92 && overlap >= 0.82;
  }
}
