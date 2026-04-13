import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentTrustLevel } from '../tools/types.js';
import type { AutomationStepOutput } from './automation-output.js';
import type { AutomationMemoryPromotionStatus } from './automation-output-persistence.js';
import { stripInvisibleChars } from '../guardian/input-sanitizer.js';
import { mkdirSecureSync, writeSecureFileSync } from '../util/secure-fs.js';

import { getGuardianBaseDir } from '../util/env.js';

const DEFAULT_BASE_PATH = join(getGuardianBaseDir(), 'automation-output');
const INDEX_FILE = 'index.json';
const RUNS_DIR = 'runs';
const MAX_SEARCH_TEXT_CHARS = 6000;
const DEFAULT_READ_CHUNK_CHARS = 12000;
const MAX_READ_CHUNK_CHARS = 60000;

export interface AutomationOutputStoreInput {
  automationId: string;
  automationName: string;
  runId: string;
  status: string;
  message?: string;
  startedAt?: number;
  completedAt?: number;
  origin?: string;
  agentId?: string;
  userId?: string;
  channel?: string;
  target?: string;
  taskId?: string;
  runLink?: string;
  steps?: AutomationStepOutput[];
}

export interface AutomationStoredOutputRef {
  storeId: string;
  runId: string;
  automationId: string;
  automationName: string;
  status: string;
  storedAt: number;
  stepCount: number;
  runLink: string;
  trustLevel: ContentTrustLevel;
  taintReasons: string[];
}

export interface AutomationOutputStoreStepRecord {
  stepId: string;
  toolName: string;
  status: string;
  message?: string;
  preview: string;
  searchText: string;
  contentType: 'json' | 'text' | 'empty';
  contentChars: number;
  storageKey?: string;
  trustLevel: ContentTrustLevel;
  taintReasons: string[];
}

export interface AutomationOutputStoreManifest {
  version: 1;
  storeId: string;
  runId: string;
  automationId: string;
  automationName: string;
  status: string;
  message?: string;
  storedAt: number;
  startedAt?: number;
  completedAt?: number;
  origin?: string;
  agentId?: string;
  userId?: string;
  channel?: string;
  target?: string;
  taskId?: string;
  runLink: string;
  summary: string;
  preview: string;
  trustLevel: ContentTrustLevel;
  taintReasons: string[];
  memoryPromotion?: AutomationMemoryPromotionStatus;
  steps: AutomationOutputStoreStepRecord[];
}

interface AutomationOutputStoreIndex {
  version: 1;
  entries: AutomationOutputStoreManifest[];
}

export interface AutomationOutputSearchInput {
  query?: string;
  automationId?: string;
  runId?: string;
  status?: string;
  limit?: number;
}

export interface AutomationOutputSearchMatch {
  runId: string;
  automationId: string;
  automationName: string;
  status: string;
  storedAt: number;
  preview: string;
  runLink: string;
  storeId: string;
  trustLevel: ContentTrustLevel;
  taintReasons: string[];
  stepId?: string;
  toolName?: string;
}

export interface AutomationOutputReadInput {
  runId: string;
  stepId?: string;
  offset?: number;
  maxChars?: number;
}

export interface AutomationOutputReadResult {
  runId: string;
  automationId: string;
  automationName: string;
  status: string;
  scope: 'run' | 'step';
  offset: number;
  nextOffset: number | null;
  totalChars: number;
  truncated: boolean;
  text: string;
  runLink: string;
  trustLevel: ContentTrustLevel;
  taintReasons: string[];
  stepId?: string;
  toolName?: string;
  manifest: {
    storeId: string;
    storedAt: number;
    stepCount: number;
    summary: string;
    steps: Array<{
      stepId: string;
      toolName: string;
      status: string;
      preview: string;
      contentChars: number;
      trustLevel: ContentTrustLevel;
      taintReasons: string[];
    }>;
  };
}

export interface AutomationOutputStoreOptions {
  basePath?: string;
  now?: () => number;
}

export class AutomationOutputStore {
  private readonly basePath: string;
  private readonly now: () => number;

  constructor(options: AutomationOutputStoreOptions = {}) {
    this.basePath = options.basePath ?? DEFAULT_BASE_PATH;
    this.now = options.now ?? Date.now;
    mkdirSecureSync(this.basePath);
  }

  saveRun(input: AutomationOutputStoreInput): AutomationStoredOutputRef {
    const normalizedRunId = input.runId.trim();
    const storeId = computeStoreId(normalizedRunId);
    const storedAt = this.now();
    const steps = Array.isArray(input.steps) ? input.steps : [];
    const runDir = join(this.basePath, RUNS_DIR, storeId);
    mkdirSecureSync(join(runDir, 'steps'));

    const storedSteps = steps.map((step, index) => this.persistStep(runDir, step, index));
    const aggregateTrust = mergeTrustLevels(storedSteps.map((step) => step.trustLevel));
    const taintReasons = uniqueStrings(storedSteps.flatMap((step) => step.taintReasons));
    const summary = buildRunSummary(input.automationName, input.status, storedSteps);
    const preview = buildRunPreview(input.message, storedSteps);
    const runLink = input.runLink?.trim() || `#/automations?runId=${encodeURIComponent(normalizedRunId)}`;

    const manifest: AutomationOutputStoreManifest = {
      version: 1,
      storeId,
      runId: normalizedRunId,
      automationId: input.automationId.trim(),
      automationName: input.automationName.trim(),
      status: normalizeText(input.status) || 'unknown',
      ...(normalizeText(input.message) ? { message: normalizeText(input.message) } : {}),
      storedAt,
      ...(Number.isFinite(input.startedAt) ? { startedAt: Number(input.startedAt) } : {}),
      ...(Number.isFinite(input.completedAt) ? { completedAt: Number(input.completedAt) } : {}),
      ...(normalizeText(input.origin) ? { origin: normalizeText(input.origin) } : {}),
      ...(normalizeText(input.agentId) ? { agentId: normalizeText(input.agentId) } : {}),
      ...(normalizeText(input.userId) ? { userId: normalizeText(input.userId) } : {}),
      ...(normalizeText(input.channel) ? { channel: normalizeText(input.channel) } : {}),
      ...(normalizeText(input.target) ? { target: normalizeText(input.target) } : {}),
      ...(normalizeText(input.taskId) ? { taskId: normalizeText(input.taskId) } : {}),
      runLink,
      summary,
      preview,
      trustLevel: aggregateTrust,
      taintReasons,
      steps: storedSteps,
    };

    writeSecureFileSync(join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    const index = this.readIndex();
    const nextEntries = index.entries.filter((entry) => entry.runId !== normalizedRunId);
    nextEntries.unshift(manifest);
    this.writeIndex({ version: 1, entries: nextEntries });

    return {
      storeId,
      runId: normalizedRunId,
      automationId: manifest.automationId,
      automationName: manifest.automationName,
      status: manifest.status,
      storedAt,
      stepCount: storedSteps.length,
      runLink,
      trustLevel: aggregateTrust,
      taintReasons,
    };
  }

  getManifest(runId: string): AutomationOutputStoreManifest | null {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) return null;
    const entry = this.readIndex().entries.find((item) => item.runId === normalizedRunId);
    if (!entry) return null;
    return this.readManifestByStoreId(entry.storeId) ?? entry;
  }

  listRecentRuns(limit = 60): AutomationOutputStoreManifest[] {
    const bounded = Math.max(1, Math.min(200, Math.floor(Number(limit) || 60)));
    return this.readIndex().entries
      .slice(0, bounded)
      .map((entry) => this.readManifestByStoreId(entry.storeId) ?? entry)
      .map((entry) => ({
        ...entry,
        ...(entry.memoryPromotion ? { memoryPromotion: { ...entry.memoryPromotion } } : {}),
        taintReasons: [...entry.taintReasons],
        steps: entry.steps.map((step) => ({
          ...step,
          ...(step.message ? { message: step.message } : {}),
          taintReasons: [...step.taintReasons],
        })),
      }));
  }

  setMemoryPromotion(runId: string, status: AutomationMemoryPromotionStatus): void {
    const manifest = this.getManifest(runId);
    if (!manifest) return;
    const nextManifest: AutomationOutputStoreManifest = {
      ...manifest,
      memoryPromotion: { ...status },
      taintReasons: [...manifest.taintReasons],
      steps: manifest.steps.map((step) => ({
        ...step,
        ...(step.message ? { message: step.message } : {}),
        taintReasons: [...step.taintReasons],
      })),
    };
    const runDir = join(this.basePath, RUNS_DIR, manifest.storeId);
    writeSecureFileSync(join(runDir, 'manifest.json'), JSON.stringify(nextManifest, null, 2));

    const index = this.readIndex();
    const nextEntries = index.entries.map((entry) => (
      entry.runId === runId
        ? { ...nextManifest }
        : entry
    ));
    this.writeIndex({ version: 1, entries: nextEntries });
  }

  search(input: AutomationOutputSearchInput = {}): AutomationOutputSearchMatch[] {
    const limit = Math.max(1, Math.min(50, Math.floor(Number(input.limit) || 10)));
    const query = normalizeText(input.query).toLowerCase();
    const terms = query.split(/\s+/g).filter(Boolean);
    const automationId = normalizeText(input.automationId);
    const runId = normalizeText(input.runId);
    const status = normalizeText(input.status).toLowerCase();

    const matches: Array<AutomationOutputSearchMatch & { score: number }> = [];

    for (const entry of this.readIndex().entries) {
      if (automationId && entry.automationId !== automationId) continue;
      if (runId && entry.runId !== runId) continue;
      if (status && entry.status.toLowerCase() !== status) continue;

      const runSearchText = [
        entry.automationName,
        entry.summary,
        entry.preview,
        entry.message,
      ].filter(Boolean).join('\n');
      const runScore = scoreSearchText(runSearchText, terms);

      if (!terms.length || runScore > 0) {
        matches.push({
          runId: entry.runId,
          automationId: entry.automationId,
          automationName: entry.automationName,
          status: entry.status,
          storedAt: entry.storedAt,
          preview: entry.preview,
          runLink: entry.runLink,
          storeId: entry.storeId,
          trustLevel: entry.trustLevel,
          taintReasons: [...entry.taintReasons],
          score: runScore,
        });
      }

      for (const step of entry.steps) {
        const stepScore = scoreSearchText(
          [step.toolName, step.preview, step.message, step.searchText].filter(Boolean).join('\n'),
          terms,
        );
        if (terms.length && stepScore === 0) continue;
        matches.push({
          runId: entry.runId,
          automationId: entry.automationId,
          automationName: entry.automationName,
          status: entry.status,
          storedAt: entry.storedAt,
          preview: step.preview,
          runLink: entry.runLink,
          storeId: entry.storeId,
          trustLevel: step.trustLevel,
          taintReasons: [...step.taintReasons],
          stepId: step.stepId,
          toolName: step.toolName,
          score: Math.max(stepScore, runScore),
        });
      }
    }

    return matches
      .sort((left, right) => right.score - left.score || right.storedAt - left.storedAt)
      .slice(0, limit)
      .map(({ score: _score, ...match }) => match);
  }

  read(input: AutomationOutputReadInput): AutomationOutputReadResult | null {
    const manifest = this.getManifest(input.runId);
    if (!manifest) return null;

    const offset = Math.max(0, Math.floor(Number(input.offset) || 0));
    const maxChars = clampReadChars(input.maxChars);

    if (input.stepId) {
      const requestedStepId = input.stepId.trim();
      const step = manifest.steps.find((item) => item.stepId === requestedStepId);
      if (!step) return null;
      const text = step.storageKey
        ? this.readStepContent(manifest.storeId, step.storageKey)
        : step.message || '(no stored output)';
      const chunk = sliceChunk(text, offset, maxChars);
      return {
        runId: manifest.runId,
        automationId: manifest.automationId,
        automationName: manifest.automationName,
        status: manifest.status,
        scope: 'step',
        offset,
        nextOffset: chunk.nextOffset,
        totalChars: text.length,
        truncated: chunk.truncated,
        text: chunk.text,
        runLink: manifest.runLink,
        trustLevel: step.trustLevel,
        taintReasons: [...step.taintReasons],
        stepId: step.stepId,
        toolName: step.toolName,
        manifest: summarizeManifest(manifest),
      };
    }

    const text = buildRunReadText(manifest, (storageKey) => this.readStepContent(manifest.storeId, storageKey));
    const chunk = sliceChunk(text, offset, maxChars);
    return {
      runId: manifest.runId,
      automationId: manifest.automationId,
      automationName: manifest.automationName,
      status: manifest.status,
      scope: 'run',
      offset,
      nextOffset: chunk.nextOffset,
      totalChars: text.length,
      truncated: chunk.truncated,
      text: chunk.text,
      runLink: manifest.runLink,
      trustLevel: manifest.trustLevel,
      taintReasons: [...manifest.taintReasons],
      manifest: summarizeManifest(manifest),
    };
  }

  private persistStep(
    runDir: string,
    step: AutomationStepOutput,
    index: number,
  ): AutomationOutputStoreStepRecord {
    const stepId = normalizeText(step.stepId) || `step-${index + 1}`;
    const toolName = normalizeText(step.toolName) || `step_${index + 1}`;
    const status = normalizeText(step.status) || 'unknown';
    const message = normalizeText(step.message);
    const serializedOutput = serializeStoredValue(step.output);
    const contentText = serializedOutput || message;
    const preview = truncateText(
      normalizeWhitespace(message || serializedOutput || `${toolName} ${status}`),
      220,
    );
    const searchText = truncateText(
      stripInvisibleChars([toolName, message, contentText].filter(Boolean).join('\n')),
      MAX_SEARCH_TEXT_CHARS,
    );
    const { trustLevel, taintReasons } = deriveStepTrust(step, toolName);
    const contentType = !serializedOutput
      ? 'empty'
      : typeof step.output === 'string'
        ? 'text'
        : 'json';
    const storageKey = serializedOutput
      ? join('steps', `${computeStoreId(stepId)}.txt`)
      : undefined;

    if (serializedOutput && storageKey) {
      writeSecureFileSync(join(runDir, storageKey), serializedOutput);
    }

    return {
      stepId,
      toolName,
      status,
      ...(message ? { message } : {}),
      preview,
      searchText,
      contentType,
      contentChars: serializedOutput.length,
      ...(storageKey ? { storageKey } : {}),
      trustLevel,
      taintReasons,
    };
  }

  private readStepContent(storeId: string, storageKey: string): string {
    const filePath = join(this.basePath, RUNS_DIR, storeId, storageKey);
    if (!existsSync(filePath)) return '(stored output not found)';
    return readFileSync(filePath, 'utf-8');
  }

  private readManifestByStoreId(storeId: string): AutomationOutputStoreManifest | null {
    const manifestPath = join(this.basePath, RUNS_DIR, storeId, 'manifest.json');
    if (!existsSync(manifestPath)) return null;
    try {
      return JSON.parse(readFileSync(manifestPath, 'utf-8')) as AutomationOutputStoreManifest;
    } catch {
      return null;
    }
  }

  private readIndex(): AutomationOutputStoreIndex {
    const indexPath = join(this.basePath, INDEX_FILE);
    if (!existsSync(indexPath)) {
      return { version: 1, entries: [] };
    }
    try {
      const parsed = JSON.parse(readFileSync(indexPath, 'utf-8')) as AutomationOutputStoreIndex;
      if (!Array.isArray(parsed.entries)) {
        return { version: 1, entries: [] };
      }
      return {
        version: 1,
        entries: parsed.entries
          .filter((entry): entry is AutomationOutputStoreManifest => Boolean(entry?.runId && entry?.storeId))
          .map((entry) => ({ ...entry, steps: Array.isArray(entry.steps) ? entry.steps.map((step) => ({ ...step })) : [] })),
      };
    } catch {
      return { version: 1, entries: [] };
    }
  }

  private writeIndex(index: AutomationOutputStoreIndex): void {
    writeSecureFileSync(join(this.basePath, INDEX_FILE), JSON.stringify(index, null, 2));
  }
}

function summarizeManifest(manifest: AutomationOutputStoreManifest): AutomationOutputReadResult['manifest'] {
  return {
    storeId: manifest.storeId,
    storedAt: manifest.storedAt,
    stepCount: manifest.steps.length,
    summary: manifest.summary,
    steps: manifest.steps.map((step) => ({
      stepId: step.stepId,
      toolName: step.toolName,
      status: step.status,
      preview: step.preview,
      contentChars: step.contentChars,
      trustLevel: step.trustLevel,
      taintReasons: [...step.taintReasons],
    })),
  };
}

function buildRunReadText(
  manifest: AutomationOutputStoreManifest,
  readStepContent: (storageKey: string) => string,
): string {
  const sections = [
    `Automation: ${manifest.automationName}`,
    `Automation ID: ${manifest.automationId}`,
    `Run ID: ${manifest.runId}`,
    `Status: ${manifest.status}`,
    `Stored At: ${new Date(manifest.storedAt).toISOString()}`,
    `Summary: ${manifest.summary}`,
    `Run Link: ${manifest.runLink}`,
    '',
    'Step Overview:',
    ...manifest.steps.map((step) => `- ${step.stepId} | ${step.toolName} | ${step.status} | ${step.preview}`),
    '',
    'Full Step Output:',
  ];

  for (const step of manifest.steps) {
    sections.push('');
    sections.push(`### ${step.stepId} (${step.toolName}) [${step.status}]`);
    if (step.message) {
      sections.push(`Message: ${step.message}`);
    }
    sections.push(step.storageKey ? readStepContent(step.storageKey) : '(no stored output)');
  }

  return sections.join('\n');
}

function clampReadChars(value: number | undefined): number {
  const numeric = Math.floor(Number(value) || DEFAULT_READ_CHUNK_CHARS);
  return Math.max(500, Math.min(MAX_READ_CHUNK_CHARS, numeric));
}

function sliceChunk(text: string, offset: number, maxChars: number): {
  text: string;
  truncated: boolean;
  nextOffset: number | null;
} {
  const safeOffset = Math.max(0, Math.min(offset, text.length));
  const sliced = text.slice(safeOffset, safeOffset + maxChars);
  const nextOffset = safeOffset + sliced.length < text.length
    ? safeOffset + sliced.length
    : null;
  return {
    text: sliced,
    truncated: nextOffset !== null,
    nextOffset,
  };
}

function buildRunSummary(
  automationName: string,
  status: string,
  steps: AutomationOutputStoreStepRecord[],
): string {
  const toolNames = uniqueStrings(steps.map((step) => step.toolName)).slice(0, 5);
  const suffix = toolNames.length > 0 ? ` Steps: ${toolNames.join(', ')}.` : '';
  return `Automation '${normalizeText(automationName) || 'Automation'}' ${normalizeText(status) || 'completed'} with ${steps.length} recorded step${steps.length === 1 ? '' : 's'}.${suffix}`;
}

function buildRunPreview(message: string | undefined, steps: AutomationOutputStoreStepRecord[]): string {
  const firstStep = steps.find((step) => step.preview.trim().length > 0)?.preview;
  return truncateText(normalizeWhitespace(message || firstStep || 'Stored automation run output.'), 220);
}

function deriveStepTrust(
  step: AutomationStepOutput,
  toolName: string,
): { trustLevel: ContentTrustLevel; taintReasons: string[] } {
  const output = isRecord(step.output) ? step.output : null;
  const explicitTrust = normalizeText(output?.trustLevel).toLowerCase();
  const explicitTaintReasons = asStringArray(output?.taintReasons);
  if (explicitTrust === 'quarantined' || explicitTrust === 'low_trust' || explicitTrust === 'trusted') {
    return {
      trustLevel: explicitTrust,
      taintReasons: explicitTaintReasons,
    };
  }
  if (explicitTaintReasons.length > 0) {
    return {
      trustLevel: 'low_trust',
      taintReasons: explicitTaintReasons,
    };
  }
  if (typeof output?._untrusted === 'string' && output._untrusted.trim()) {
    return {
      trustLevel: 'low_trust',
      taintReasons: ['untrusted_output_marker'],
    };
  }
  if (looksLikeRemoteContentTool(toolName)) {
    return {
      trustLevel: 'low_trust',
      taintReasons: ['remote_or_browser_content'],
    };
  }
  return {
    trustLevel: 'trusted',
    taintReasons: [],
  };
}

function looksLikeRemoteContentTool(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  return normalized.startsWith('web_')
    || normalized.startsWith('browser_')
    || normalized.startsWith('forum_')
    || normalized.startsWith('gmail_')
    || normalized === 'gws'
    || normalized.startsWith('mcp-')
    || normalized.startsWith('mcp_')
    || normalized === 'chrome_job';
}

function scoreSearchText(text: string, terms: string[]): number {
  if (!terms.length) return 1;
  const haystack = normalizeText(text).toLowerCase();
  if (!haystack) return 0;
  let score = 0;
  for (const term of terms) {
    if (!haystack.includes(term)) continue;
    score += 10;
    if (haystack.startsWith(term)) score += 4;
  }
  return score;
}

function serializeStoredValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function mergeTrustLevels(levels: ContentTrustLevel[]): ContentTrustLevel {
  if (levels.includes('quarantined')) return 'quarantined';
  if (levels.includes('low_trust')) return 'low_trust';
  return 'trusted';
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function normalizeWhitespace(text: string): string {
  return normalizeText(stripInvisibleChars(text).replace(/\s+/g, ' '));
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function computeStoreId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim()))];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim())
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
