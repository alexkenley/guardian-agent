import { createHash, randomUUID } from 'node:crypto';
import type { ExecutionArtifactRef, ExecutionArtifactType } from './types.js';

export interface SearchResultArtifactMatch {
  path: string;
  line?: number;
  matchType?: string;
  snippetPreview?: string;
  snippetHash?: string;
}

export interface SearchResultSetContent {
  query?: string;
  matches: SearchResultArtifactMatch[];
  totalMatches: number;
  truncated: boolean;
}

export interface FileReadArtifactExcerpt {
  path: string;
  bytes?: number;
  truncated: boolean;
  lineStart: number;
  lineEnd: number;
  excerpt: string;
  contentHash: string;
}

export interface FileReadSetContent {
  files: FileReadArtifactExcerpt[];
}

export interface EvidenceLedgerRecord {
  artifactId: string;
  artifactType: ExecutionArtifactType;
  summary: string;
  refs: string[];
  trustLevel?: 'trusted' | 'low_trust' | 'quarantined';
  taintReasons?: string[];
}

export interface EvidenceLedgerContent {
  records: EvidenceLedgerRecord[];
}

export interface SynthesisDraftCitation {
  artifactId: string;
  refs: string[];
}

export interface SynthesisDraftContent {
  contentPreview: string;
  contentHash: string;
  citedArtifactIds: string[];
  citations: SynthesisDraftCitation[];
  truncated: boolean;
}

export interface SynthesisDraftValidationResult {
  valid: boolean;
  missingArtifactIds: string[];
  invalidRefs: Array<{
    artifactId: string;
    refs: string[];
  }>;
}

export type ExecutionArtifactContent =
  | SearchResultSetContent
  | FileReadSetContent
  | EvidenceLedgerContent
  | SynthesisDraftContent
  | Record<string, unknown>;

export interface ExecutionArtifact<TContent extends ExecutionArtifactContent = ExecutionArtifactContent> {
  artifactId: string;
  graphId: string;
  nodeId: string;
  artifactType: ExecutionArtifactType;
  label: string;
  preview?: string;
  refs: string[];
  trustLevel: 'trusted' | 'low_trust' | 'quarantined';
  taintReasons: string[];
  redactionPolicy: string;
  content: TContent;
  createdAt: number;
}

export interface ExecutionArtifactStoreOptions {
  maxArtifacts?: number;
}

const DEFAULT_MAX_ARTIFACTS = 500;
const MAX_PREVIEW_CHARS = 220;
const MAX_SNIPPET_PREVIEW_CHARS = 240;
const MAX_FILE_EXCERPT_CHARS = 8_000;
const MAX_SYNTHESIS_ARTIFACT_CHARS = 12_000;

export class ExecutionArtifactStore {
  private readonly artifacts = new Map<string, ExecutionArtifact>();
  private readonly maxArtifacts: number;

  constructor(options: ExecutionArtifactStoreOptions = {}) {
    this.maxArtifacts = Math.max(1, options.maxArtifacts ?? DEFAULT_MAX_ARTIFACTS);
  }

  writeArtifact<TContent extends ExecutionArtifactContent>(artifact: ExecutionArtifact<TContent>): ExecutionArtifact<TContent> {
    if (this.artifacts.has(artifact.artifactId)) {
      throw new Error(`Artifact already exists: ${artifact.artifactId}`);
    }
    this.artifacts.set(artifact.artifactId, cloneArtifact(artifact));
    this.prune();
    return cloneArtifact(artifact);
  }

  getArtifact(artifactId: string): ExecutionArtifact | null {
    const artifact = this.artifacts.get(artifactId.trim());
    return artifact ? cloneArtifact(artifact) : null;
  }

  listArtifacts(): ExecutionArtifact[] {
    return [...this.artifacts.values()]
      .sort((left, right) => left.createdAt - right.createdAt || left.artifactId.localeCompare(right.artifactId))
      .map(cloneArtifact);
  }

  private prune(): void {
    const sorted = [...this.artifacts.values()]
      .sort((left, right) => right.createdAt - left.createdAt || left.artifactId.localeCompare(right.artifactId));
    for (const artifact of sorted.slice(this.maxArtifacts)) {
      this.artifacts.delete(artifact.artifactId);
    }
  }
}

export function artifactRefFromArtifact(artifact: ExecutionArtifact): ExecutionArtifactRef {
  return {
    artifactId: artifact.artifactId,
    graphId: artifact.graphId,
    nodeId: artifact.nodeId,
    artifactType: artifact.artifactType,
    label: artifact.label,
    ...(artifact.preview ? { preview: artifact.preview } : {}),
    trustLevel: artifact.trustLevel,
    ...(artifact.taintReasons.length > 0 ? { taintReasons: [...artifact.taintReasons] } : {}),
    redactionPolicy: artifact.redactionPolicy,
    createdAt: artifact.createdAt,
  };
}

export function buildSearchResultSetArtifact(input: {
  graphId: string;
  nodeId: string;
  artifactId?: string;
  label?: string;
  query?: string;
  matches: Array<Record<string, unknown>>;
  truncated?: boolean;
  trustLevel?: ExecutionArtifact['trustLevel'];
  taintReasons?: string[];
  createdAt: number;
}): ExecutionArtifact<SearchResultSetContent> {
  const matches = input.matches
    .map((match) => normalizeSearchMatch(match))
    .filter((match): match is SearchResultArtifactMatch => !!match)
    .slice(0, 100);
  const query = normalizeText(input.query);
  const preview = truncateText(
    `Search${query ? ` "${query}"` : ''} returned ${input.matches.length} matches${input.truncated ? ' (truncated)' : ''}.`,
    MAX_PREVIEW_CHARS,
  );
  return {
    artifactId: input.artifactId ?? `artifact:${randomUUID()}`,
    graphId: input.graphId,
    nodeId: input.nodeId,
    artifactType: 'SearchResultSet',
    label: input.label ?? 'Search results',
    preview,
    refs: uniqueStrings(matches.map((match) => match.line ? `${match.path}:${match.line}` : match.path)),
    trustLevel: input.trustLevel ?? 'trusted',
    taintReasons: [...(input.taintReasons ?? [])],
    redactionPolicy: 'bounded_snippet_preview',
    content: {
      ...(query ? { query } : {}),
      matches,
      totalMatches: input.matches.length,
      truncated: input.truncated === true || matches.length < input.matches.length,
    },
    createdAt: input.createdAt,
  };
}

export function buildFileReadSetArtifact(input: {
  graphId: string;
  nodeId: string;
  artifactId?: string;
  label?: string;
  path: string;
  content: string;
  bytes?: number;
  truncated?: boolean;
  trustLevel?: ExecutionArtifact['trustLevel'];
  taintReasons?: string[];
  createdAt: number;
}): ExecutionArtifact<FileReadSetContent> {
  const path = normalizePath(input.path) ?? 'unknown';
  const excerpt = buildFileExcerpt(input.content);
  const file: FileReadArtifactExcerpt = {
    path,
    ...(typeof input.bytes === 'number' && Number.isFinite(input.bytes) ? { bytes: input.bytes } : {}),
    truncated: input.truncated === true || excerpt.truncated,
    lineStart: 1,
    lineEnd: excerpt.lineEnd,
    excerpt: excerpt.text,
    contentHash: hashText(input.content),
  };
  return {
    artifactId: input.artifactId ?? `artifact:${randomUUID()}`,
    graphId: input.graphId,
    nodeId: input.nodeId,
    artifactType: 'FileReadSet',
    label: input.label ?? `File read: ${path}`,
    preview: truncateText(`Read ${path}${file.bytes ? ` (${file.bytes} bytes)` : ''}${file.truncated ? ' (truncated)' : ''}.`, MAX_PREVIEW_CHARS),
    refs: [path],
    trustLevel: input.trustLevel ?? 'trusted',
    taintReasons: [...(input.taintReasons ?? [])],
    redactionPolicy: 'bounded_excerpt',
    content: { files: [file] },
    createdAt: input.createdAt,
  };
}

export function buildEvidenceLedgerArtifact(input: {
  graphId: string;
  nodeId: string;
  artifactId?: string;
  artifacts: ExecutionArtifact[];
  createdAt: number;
}): ExecutionArtifact<EvidenceLedgerContent> {
  const records = input.artifacts.map((artifact) => ({
    artifactId: artifact.artifactId,
    artifactType: artifact.artifactType,
    summary: artifact.preview ?? artifact.label,
    refs: [...artifact.refs],
    trustLevel: artifact.trustLevel,
    ...(artifact.taintReasons.length > 0 ? { taintReasons: [...artifact.taintReasons] } : {}),
  }));
  return {
    artifactId: input.artifactId ?? `artifact:${randomUUID()}`,
    graphId: input.graphId,
    nodeId: input.nodeId,
    artifactType: 'EvidenceLedger',
    label: 'Evidence ledger',
    preview: truncateText(`Evidence ledger with ${records.length} artifacts.`, MAX_PREVIEW_CHARS),
    refs: uniqueStrings(records.flatMap((record) => record.refs)),
    trustLevel: records.some((record) => record.trustLevel === 'quarantined') ? 'quarantined' : records.some((record) => record.trustLevel === 'low_trust') ? 'low_trust' : 'trusted',
    taintReasons: uniqueStrings(records.flatMap((record) => record.taintReasons ?? [])),
    redactionPolicy: 'artifact_refs_only',
    content: { records },
    createdAt: input.createdAt,
  };
}

export function buildSynthesisDraftArtifact(input: {
  graphId: string;
  nodeId: string;
  artifactId?: string;
  content: string;
  sourceArtifacts: ExecutionArtifact[];
  createdAt: number;
}): ExecutionArtifact<SynthesisDraftContent> {
  const contentPreview = truncateText(input.content, MAX_SYNTHESIS_ARTIFACT_CHARS) ?? '';
  const citations = input.sourceArtifacts
    .filter((artifact) => artifact.refs.length > 0)
    .map((artifact) => ({
      artifactId: artifact.artifactId,
      refs: artifact.refs.slice(0, 20),
    }));
  return {
    artifactId: input.artifactId ?? `artifact:${randomUUID()}`,
    graphId: input.graphId,
    nodeId: input.nodeId,
    artifactType: 'SynthesisDraft',
    label: 'Grounded synthesis draft',
    preview: truncateText(contentPreview, MAX_PREVIEW_CHARS),
    refs: uniqueStrings(citations.flatMap((citation) => citation.refs)),
    trustLevel: input.sourceArtifacts.some((artifact) => artifact.trustLevel === 'quarantined') ? 'quarantined' : input.sourceArtifacts.some((artifact) => artifact.trustLevel === 'low_trust') ? 'low_trust' : 'trusted',
    taintReasons: uniqueStrings(input.sourceArtifacts.flatMap((artifact) => artifact.taintReasons)),
    redactionPolicy: 'bounded_answer_preview',
    content: {
      contentPreview,
      contentHash: hashText(input.content),
      citedArtifactIds: input.sourceArtifacts.map((artifact) => artifact.artifactId),
      citations,
      truncated: contentPreview.length < input.content.length,
    },
    createdAt: input.createdAt,
  };
}

export function formatEvidenceArtifactsForSynthesis(input: {
  ledger: ExecutionArtifact<EvidenceLedgerContent>;
  sourceArtifacts: ExecutionArtifact[];
  maxChars?: number;
}): string {
  const artifactsById = new Map(input.sourceArtifacts.map((artifact) => [artifact.artifactId, artifact]));
  const lines: string[] = [];
  lines.push(`EvidenceLedger artifact: ${input.ledger.artifactId}`);
  for (const record of input.ledger.content.records.slice(0, 24)) {
    lines.push('');
    lines.push(`[artifact:${record.artifactId}] ${record.artifactType}`);
    lines.push(`Summary: ${record.summary}`);
    if (record.refs.length > 0) {
      lines.push('Refs:');
      for (const ref of record.refs.slice(0, 12)) {
        lines.push(`- ${ref}`);
      }
    }
    const artifact = artifactsById.get(record.artifactId);
    if (!artifact) continue;
    if (artifact.artifactType === 'SearchResultSet') {
      const content = artifact.content as SearchResultSetContent;
      for (const match of content.matches.slice(0, 12)) {
        const location = match.line ? `${match.path}:${match.line}` : match.path;
        lines.push(`- ${location}${match.snippetPreview ? `: ${match.snippetPreview}` : ''}`);
      }
    }
    if (artifact.artifactType === 'FileReadSet') {
      const content = artifact.content as FileReadSetContent;
      for (const file of content.files.slice(0, 4)) {
        lines.push(`Excerpt from ${file.path}:${file.lineStart}-${file.lineEnd}`);
        lines.push(file.excerpt);
      }
    }
  }
  return truncateText(lines.join('\n').trim(), input.maxChars ?? 24_000) ?? '';
}

export function validateSynthesisDraftArtifact(input: {
  draft: ExecutionArtifact<SynthesisDraftContent>;
  sourceArtifacts: ExecutionArtifact[];
}): SynthesisDraftValidationResult {
  const artifactsById = new Map(input.sourceArtifacts.map((artifact) => [artifact.artifactId, artifact]));
  const missingArtifactIds = uniqueStrings([
    ...input.draft.content.citedArtifactIds.filter((artifactId) => !artifactsById.has(artifactId)),
    ...input.draft.content.citations
      .map((citation) => citation.artifactId)
      .filter((artifactId) => !artifactsById.has(artifactId)),
  ]);
  const invalidRefs = input.draft.content.citations.flatMap((citation) => {
    const artifact = artifactsById.get(citation.artifactId);
    if (!artifact) return [];
    const knownRefs = new Set(artifact.refs);
    const refs = citation.refs.filter((ref) => !knownRefs.has(ref));
    return refs.length > 0 ? [{ artifactId: citation.artifactId, refs }] : [];
  });
  return {
    valid: missingArtifactIds.length === 0 && invalidRefs.length === 0,
    missingArtifactIds,
    invalidRefs,
  };
}

function normalizeSearchMatch(match: Record<string, unknown>): SearchResultArtifactMatch | null {
  const path = normalizePath(stringValue(match.relativePath) || stringValue(match.path));
  if (!path) return null;
  const line = numberValue(match.line) ?? numberValue(match.lineNumber);
  const snippet = normalizeText(stringValue(match.snippet));
  return {
    path,
    ...(typeof line === 'number' ? { line } : {}),
    ...(normalizeText(stringValue(match.matchType)) ? { matchType: normalizeText(stringValue(match.matchType)) } : {}),
    ...(snippet ? { snippetPreview: truncateText(snippet, MAX_SNIPPET_PREVIEW_CHARS), snippetHash: hashText(snippet) } : {}),
  };
}

function buildFileExcerpt(content: string): { text: string; lineEnd: number; truncated: boolean } {
  const truncated = content.length > MAX_FILE_EXCERPT_CHARS;
  const text = truncated ? content.slice(0, MAX_FILE_EXCERPT_CHARS) : content;
  return {
    text,
    lineEnd: Math.max(1, text.split(/\r?\n/).length),
    truncated,
  };
}

function cloneArtifact<TContent extends ExecutionArtifactContent>(artifact: ExecutionArtifact<TContent>): ExecutionArtifact<TContent> {
  return {
    ...artifact,
    refs: [...artifact.refs],
    taintReasons: [...artifact.taintReasons],
    content: cloneJson(artifact.content) as TContent,
  };
}

function cloneJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizePath(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  return normalized ? normalized : undefined;
}

function truncateText(value: string | undefined, maxChars: number): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function normalizeText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(numeric) ? Math.max(1, Math.floor(numeric)) : undefined;
}
