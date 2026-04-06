import { isAbsolute, relative, resolve, sep } from 'node:path';

import type {
  ConfigUpdate,
  DashboardCodingBackendInfo,
  RedactedCloudConfig,
  RedactedConfig,
} from './channels/web-types.js';
import { DEFAULT_CONFIG, type GuardianAgentConfig } from './config/types.js';
import { normalizeHttpUrlRecord, normalizeOptionalHttpUrlInput } from './config/input-normalization.js';
import { getProviderLocality } from './llm/provider-metadata.js';
import type { ChatMessage } from './llm/types.js';
import {
  formatCodeSessionFileReferencesForPrompt,
  resolveCodeSessionFileReferences,
  sanitizeCodeSessionFileReferences,
  type CodeSessionFileReferenceInput,
} from './runtime/code-session-file-references.js';
import { CODING_BACKEND_PRESETS } from './runtime/coding-backend-presets.js';
import {
  DEFAULT_ASSISTANT_SECURITY_AUTO_CONTAINMENT_CATEGORIES,
  DEFAULT_ASSISTANT_SECURITY_AUTO_CONTAINMENT_CONFIDENCE,
  DEFAULT_ASSISTANT_SECURITY_AUTO_CONTAINMENT_SEVERITY,
  DEFAULT_ASSISTANT_SECURITY_MONITORING_CRON,
  DEFAULT_ASSISTANT_SECURITY_MONITORING_PROFILE,
  DEFAULT_DEPLOYMENT_PROFILE,
  DEFAULT_SECURITY_OPERATING_MODE,
  DEFAULT_SECURITY_TRIAGE_LLM_PROVIDER,
} from './runtime/security-controls.js';
import { resolveDegradedFallbackConfig } from './sandbox/security-controls.js';
import { normalizeCpanelConnectionConfig } from './tools/cloud/cpanel-profile.js';
import {
  compactMessagesIfOverBudget as _compactMessagesIfOverBudget,
  type ContextCompactionResult,
} from './util/context-budget.js';

const MAX_TOOL_RESULT_MESSAGE_CHARS = 8_000;
const MAX_TOOL_RESULT_STRING_CHARS = 600;
const MAX_TOOL_RESULT_ARRAY_ITEMS = 10;
const MAX_TOOL_RESULT_OBJECT_KEYS = 20;
const DIRECT_DEFINITION_SEARCH_PATH_LIMIT = 8;

type DirectFilesystemSearchMatch = {
  path: string;
  matchType: string;
  snippet?: string;
};

function isLocalProviderEndpoint(_baseUrl: string | undefined, providerType: string | undefined): boolean {
  return getProviderLocality(providerType) === 'local';
}

function stripLeadingContextPrefix(input: string): string {
  let normalized = input.trimStart();
  while (normalized.startsWith('[Context:')) {
    const end = normalized.indexOf(']');
    if (end === -1) break;
    normalized = normalized.slice(end + 1).trimStart();
  }
  return normalized;
}

function toString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeCodingBackendSelection(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  if (lower === 'unknown' || lower === 'none' || lower === 'unspecified' || lower === 'not specified' || lower === 'n/a') {
    return undefined;
  }
  return trimmed;
}

function normalizeScheduledEmailBody(body: string | undefined, subject: string): string {
  const trimmed = (body ?? '').trim();
  if (!trimmed) return subject;
  if (/^the same as the subject\.?$/i.test(trimmed)) return subject;
  if (/^same as the subject\.?$/i.test(trimmed)) return subject;
  return trimmed;
}

function formatDirectCodeSessionLine(
  session: { title?: string | null; workspaceRoot?: string | null; id?: string | null },
  current: boolean,
): string {
  const title = session.title?.trim() || 'Untitled session';
  const workspaceRoot = session.workspaceRoot?.trim() || '(unknown workspace)';
  const sessionId = session.id?.trim() || '';
  const parts = [`- ${current ? 'CURRENT: ' : ''}${title} — ${workspaceRoot}`];
  if (sessionId) {
    parts.push(`id=${sessionId}`);
  }
  return parts.join(' ');
}

function isAffirmativeContinuation(content: string): boolean {
  return /^(?:ok|okay|yes|yep|yeah|sure|please do|go ahead|do it|create it|make it so|proceed)\b/i.test(content.trim());
}

function summarizeToolRoundFallback(results: Array<{ toolName: string; result: Record<string, unknown> }>): string {
  const summaries = results
    .map(({ toolName, result }) => summarizeSingleToolFallback(toolName, result))
    .filter((summary): summary is string => !!summary);
  if (summaries.length === 0) return '';
  if (summaries.length === 1) return summaries[0];
  return `Completed the requested actions:\n${summaries.map((summary) => `- ${summary}`).join('\n')}`;
}

function summarizeSingleToolFallback(toolName: string, result: Record<string, unknown>): string {
  const message = toString(result.message).trim() || extractToolFallbackOutputMessage(result);
  if (message) return message;

  const status = toString(result.status).trim().toLowerCase();
  if (status === 'pending_approval') return `${toolName} is awaiting approval.`;
  if (result.success === true || status === 'succeeded' || status === 'completed') return `Completed ${toolName}.`;
  return `Attempted ${toolName}, but it did not complete successfully.`;
}

function extractToolFallbackOutputMessage(result: Record<string, unknown>): string {
  if (!isRecord(result.output)) return '';
  return toString(result.output.message).trim();
}

function toBoolean(value: unknown): boolean {
  return value === true;
}

function toNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

interface DirectGoogleWorkspaceIntent {
  kind: 'gmail_unread' | 'gmail_recent_senders' | 'gmail_recent_summary';
  count: number;
}

const MAILBOX_PROVIDER_PATTERN = /\b(?:gmail|google workspace|outlook|microsoft 365|office 365)\b/i;
const MAILBOX_NOUN_PATTERN = /\b(?:gmail|inbox|emails?|email|mail)\b/i;
const MAILBOX_READ_TARGET_PATTERN = /\b(?:gmail|google workspace|inbox|emails?|email|mail|outlook\s+(?:mail|email|emails?|inbox)|(?:microsoft|office)\s+365(?:\s+outlook)?\s+(?:mail|email|emails?|inbox))\b/i;

interface GmailMessageSummary {
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

function summarizeM365From(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  const emailAddress = record.emailAddress;
  if (!emailAddress || typeof emailAddress !== 'object') return '';
  const addressRecord = emailAddress as Record<string, unknown>;
  const name = typeof addressRecord.name === 'string' ? addressRecord.name.trim() : '';
  const address = typeof addressRecord.address === 'string' ? addressRecord.address.trim() : '';
  if (name && address) return `${name} <${address}>`;
  return name || address;
}

function summarizeGmailMessage(output: unknown): GmailMessageSummary | null {
  if (!output || typeof output !== 'object') return null;

  const data = output as {
    snippet?: unknown;
    payload?: { headers?: unknown };
  };
  const headers = Array.isArray(data.payload?.headers)
    ? data.payload.headers as Array<{ name?: unknown; value?: unknown }>
    : [];

  return {
    from: findHeaderValue(headers, 'from'),
    subject: findHeaderValue(headers, 'subject'),
    date: findHeaderValue(headers, 'date'),
    snippet: toString(data.snippet),
  };
}

function findHeaderValue(
  headers: Array<{ name?: unknown; value?: unknown }>,
  name: string,
): string {
  const target = name.toLowerCase();
  for (const header of headers) {
    if (toString(header.name).toLowerCase() === target) {
      return toString(header.value);
    }
  }
  return '';
}

function shouldRefreshCodeSessionFocus(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('[User approved the pending tool action(s)')) return false;
  if (trimmed.startsWith('[Code Approval Continuation]')) return false;
  if (/^(approve|approved|deny|denied|reject|rejected)\b/i.test(trimmed)) return false;
  if (isAffirmativeContinuation(trimmed)) return false;
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  return wordCount >= 3 || trimmed.length >= 24;
}

function shouldRefreshCodeSessionWorkingSet(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('[User approved the pending tool action(s)')) return false;
  if (trimmed.startsWith('[Code Approval Continuation]')) return false;
  return true;
}

function summarizeCodeSessionFocus(content: string, selectedFilePath?: string | null): string {
  const compact = content.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  const truncated = compact.length > 240
    ? `${compact.slice(0, 237).trimEnd()}...`
    : compact;
  if (selectedFilePath) {
    return `${truncated} Selected file: ${selectedFilePath}.`;
  }
  return truncated;
}

function normalizeDirectFilesystemSearchMatches(
  matches: Array<{ relativePath?: unknown; path?: unknown; matchType?: unknown; snippet?: unknown }>,
): DirectFilesystemSearchMatch[] {
  return matches
    .map((match) => {
      const path = toString(match.relativePath) || toString(match.path);
      if (!path) return null;
      return {
        path,
        matchType: toString(match.matchType) || 'name',
        ...(toString(match.snippet) ? { snippet: toString(match.snippet) } : {}),
      };
    })
    .filter((match): match is DirectFilesystemSearchMatch => !!match);
}

function isDefinitionStyleFilesystemSearchRequest(content: string): boolean {
  const text = stripLeadingContextPrefix(content).trim().toLowerCase();
  if (!text) return false;
  return /\b(?:which|what)\s+files?\s+(?:define|controls?|handles?|own)\b/.test(text)
    || /\btell\s+me\s+which\s+files?\s+(?:define|controls?|handles?)\b/.test(text)
    || /\bwhere\s+(?:is|are)\b.*\bdefined\b/.test(text)
    || /\bwhat\s+defines\b/.test(text);
}

function classifyFilesystemSearchPath(path: string): 'source' | 'test' | 'doc' | 'script' | 'other' {
  const normalized = path.replace(/\\/g, '/').toLowerCase();
  if (normalized.endsWith('/reference-guide.ts')) return 'doc';
  if (/^(src|web\/|native\/)/.test(normalized) && !/(\.test\.|\.spec\.|\/__tests__\/)/.test(normalized)) {
    return 'source';
  }
  if (/(\.test\.|\.spec\.|\/__tests__\/)/.test(normalized)) return 'test';
  if (/^(docs|doc\/|reference-guide)/.test(normalized) || normalized.includes('/docs/')) return 'doc';
  if (/^(scripts|script\/)/.test(normalized) || normalized.includes('/scripts/')) return 'script';
  return 'other';
}

function scoreDefinitionSearchMatch(
  match: DirectFilesystemSearchMatch,
  requestText: string,
): number {
  const pathClass = classifyFilesystemSearchPath(match.path);
  const haystack = `${match.path}\n${match.snippet ?? ''}`.toLowerCase();
  const request = stripLeadingContextPrefix(requestText).trim().toLowerCase();
  const fileName = match.path.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  const routingFocused = /\b(route|routing|router|tier|provider)\b/.test(request);
  let score = 0;

  switch (pathClass) {
    case 'source':
      score += 80;
      break;
    case 'other':
      score += 20;
      break;
    case 'script':
      score -= 10;
      break;
    case 'doc':
      score -= 50;
      break;
    case 'test':
      score -= 70;
      break;
  }

  if (match.matchType === 'content') score += 12;
  if (match.matchType === 'name') score += 4;

  if (routingFocused) {
    if (/\b(route|routing|router|routed)\b/.test(haystack)) score += 24;
    if (/\b(tier|locality|managed_cloud|frontier|provider)\b/.test(haystack)) score += 16;
    if (/\b(register|registered|default|config)\b/.test(haystack)) score += 10;
    if (/(provider|registry|metadata|router|routing|dispatch|profile|ollama)/.test(fileName)) score += 18;
    if (/(types|reference-guide)\.ts$/.test(fileName)) score -= 18;
  }

  if (/\b(define|definition|configured|owned)\b/.test(haystack)) score += 6;
  if (/\bexamples?:\b/.test(haystack)) score -= 28;
  if (/\bsearch the repo for\b/.test(haystack) || /\btell me which files define\b/.test(haystack)) score -= 24;
  if (/\brequesttext\b/.test(haystack) || /\bquery:\s*['"`]/.test(haystack)) score -= 20;

  return score;
}

function formatDirectFilesystemSearchMatchLine(match: DirectFilesystemSearchMatch): string {
  if (match.matchType === 'content' && match.snippet) {
    return `- ${match.path} [content]: ${match.snippet}`;
  }
  return `- ${match.path} [${match.matchType}]`;
}

function summarizeOmittedFilesystemSearchClasses(
  matches: DirectFilesystemSearchMatch[],
  includedPaths: Set<string>,
): string | null {
  const counts = {
    test: 0,
    doc: 0,
    script: 0,
    other: 0,
  };
  for (const match of matches) {
    if (includedPaths.has(match.path)) continue;
    const pathClass = classifyFilesystemSearchPath(match.path);
    if (pathClass === 'test' || pathClass === 'doc' || pathClass === 'script' || pathClass === 'other') {
      counts[pathClass] += 1;
    }
  }
  const parts = [
    counts.test > 0 ? `${counts.test} test match${counts.test === 1 ? '' : 'es'}` : '',
    counts.doc > 0 ? `${counts.doc} doc match${counts.doc === 1 ? '' : 'es'}` : '',
    counts.script > 0 ? `${counts.script} script match${counts.script === 1 ? '' : 'es'}` : '',
    counts.other > 0 ? `${counts.other} other low-signal match${counts.other === 1 ? '' : 'es'}` : '',
  ].filter(Boolean);
  return parts.length > 0
    ? `I left out ${parts.join(', ')} to keep this focused on implementation files.`
    : null;
}

function isLowSignalDefinitionMatch(
  match: DirectFilesystemSearchMatch,
  requestText: string,
): boolean {
  const haystack = `${match.path}\n${match.snippet ?? ''}`.toLowerCase();
  const request = stripLeadingContextPrefix(requestText).trim().toLowerCase();
  const quotedQuery = extractQuotedDefinitionQuery(request);
  if (/\bexamples?:\b/.test(haystack) && /\bsearch the repo for\b/.test(haystack)) return true;
  if (/\brequesttext\b/.test(haystack) || /\bquery:\s*['"`]/.test(haystack)) return true;
  if (quotedQuery && haystack.includes(quotedQuery) && /\b(search the repo for|tell me which files define)\b/.test(haystack)) {
    return true;
  }
  return false;
}

function extractQuotedDefinitionQuery(requestText: string): string | null {
  const match = requestText.match(/["']([^"']{2,120})["']/);
  return match?.[1]?.trim().toLowerCase() || null;
}

function formatDirectFilesystemSearchResponse(input: {
  requestText: string;
  root: string;
  query: string;
  scannedFiles: number | null;
  truncated: boolean;
  matches: Array<{ relativePath?: unknown; path?: unknown; matchType?: unknown; snippet?: unknown }>;
}): string {
  const normalizedMatches = normalizeDirectFilesystemSearchMatches(input.matches);
  const scannedSuffix = input.scannedFiles !== null ? ` (scanned ${input.scannedFiles} files)` : '';
  if (normalizedMatches.length === 0) {
    return `I searched "${input.root}" for "${input.query}" and found no matches${scannedSuffix}.`;
  }

  if (!isDefinitionStyleFilesystemSearchRequest(input.requestText)) {
    const lines = [
      `I searched "${input.root}" for "${input.query}"${scannedSuffix}.`,
      `Found ${normalizedMatches.length} match${normalizedMatches.length === 1 ? '' : 'es'}:`,
      ...normalizedMatches.slice(0, 20).map((match) => formatDirectFilesystemSearchMatchLine(match)),
    ];
    if (normalizedMatches.length > 20) {
      lines.push(`- ...and ${normalizedMatches.length - 20} more`);
    }
    if (input.truncated) {
      lines.push('Search stopped at configured limits; narrow query or increase maxResults/maxFiles if needed.');
    }
    return lines.join('\n');
  }

  const ranked = [...normalizedMatches].sort((left, right) => {
    const scoreDelta = scoreDefinitionSearchMatch(right, input.requestText) - scoreDefinitionSearchMatch(left, input.requestText);
    if (scoreDelta !== 0) return scoreDelta;
    return left.path.localeCompare(right.path);
  });
  const filtered = ranked.filter((match) => !isLowSignalDefinitionMatch(match, input.requestText));
  const sourceOnly = filtered.filter((match) => classifyFilesystemSearchPath(match.path) === 'source');
  const curatedBase = sourceOnly.length > 0
    ? sourceOnly
    : (filtered.length > 0 ? filtered : ranked);
  const curated = curatedBase.slice(0, DIRECT_DEFINITION_SEARCH_PATH_LIMIT);
  const includedPaths = new Set(curated.map((match) => match.path));
  const omittedSummary = summarizeOmittedFilesystemSearchClasses(normalizedMatches, includedPaths);
  const lines = [
    `I searched "${input.root}" for "${input.query}"${scannedSuffix}.`,
    `The implementation files most likely defining this are:`,
    ...curated.map((match) => formatDirectFilesystemSearchMatchLine(match)),
  ];
  if (omittedSummary) {
    lines.push(omittedSummary);
  } else if (normalizedMatches.length > curated.length) {
    lines.push(`I omitted ${normalizedMatches.length - curated.length} additional lower-priority match${normalizedMatches.length - curated.length === 1 ? '' : 'es'}.`);
  }
  if (input.truncated) {
    lines.push('Search stopped at configured limits; narrow query or increase maxResults/maxFiles if needed.');
  }
  return lines.join('\n');
}

function normalizeCodeSessionPromptPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;

  if (sep === '/') {
    const driveMatch = trimmed.match(/^([a-zA-Z]):[\\/](.*)$/);
    if (driveMatch) {
      const drive = driveMatch[1].toLowerCase();
      const rest = driveMatch[2].replace(/\\/g, '/');
      return `/mnt/${drive}/${rest}`;
    }
    return trimmed.replace(/\\/g, '/');
  }

  const mntMatch = trimmed.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (mntMatch) {
    const drive = mntMatch[1].toUpperCase();
    const rest = mntMatch[2].replace(/\//g, '\\');
    return `${drive}:\\${rest}`;
  }
  return trimmed.replace(/\//g, '\\');
}

function getCodeSessionPromptRelativePath(
  value: string | null | undefined,
  workspaceRoot: string,
): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = normalizeCodeSessionPromptPath(value);
  const resolvedPath = isAbsolute(normalized)
    ? resolve(normalized)
    : resolve(workspaceRoot, normalized);
  const relativePath = relative(workspaceRoot, resolvedPath);
  if (!relativePath || relativePath === '') return '.';
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    return null;
  }
  return relativePath.replace(/\\/g, '/');
}

function buildCodeSessionWorkspaceAwarenessQuery(
  content: string,
  fileReferences: ReadonlyArray<CodeSessionFileReferenceInput> | null | undefined,
): string {
  const referenceSuffix = Array.isArray(fileReferences) && fileReferences.length > 0
    ? fileReferences.map((reference) => reference.path).join(' ')
    : '';
  return [content.trim(), referenceSuffix].filter(Boolean).join('\n');
}

function buildCodeSessionTaggedFilePromptContext(
  workspaceRoot: string,
  fileReferences: ReadonlyArray<CodeSessionFileReferenceInput> | null | undefined,
): string {
  if (!Array.isArray(fileReferences) || fileReferences.length === 0) return '';
  const resolvedReferences = resolveCodeSessionFileReferences(workspaceRoot, fileReferences);
  return formatCodeSessionFileReferencesForPrompt(resolvedReferences);
}

function sameCodeWorkspaceWorkingSet(
  left: {
    query?: string;
    rationale?: string;
    files?: Array<{ path?: string; reason?: string }>;
    snippets?: Array<{ path?: string; excerpt?: string }>;
  } | null | undefined,
  right: {
    query?: string;
    rationale?: string;
    files?: Array<{ path?: string; reason?: string }>;
    snippets?: Array<{ path?: string; excerpt?: string }>;
  } | null | undefined,
): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  const leftFiles = Array.isArray(left.files) ? left.files : [];
  const rightFiles = Array.isArray(right.files) ? right.files : [];
  const leftSnippets = Array.isArray(left.snippets) ? left.snippets : [];
  const rightSnippets = Array.isArray(right.snippets) ? right.snippets : [];
  if ((left.query ?? '') !== (right.query ?? '')) return false;
  if ((left.rationale ?? '') !== (right.rationale ?? '')) return false;
  if (leftFiles.length !== rightFiles.length || leftSnippets.length !== rightSnippets.length) return false;
  for (let index = 0; index < leftFiles.length; index += 1) {
    if ((leftFiles[index]?.path ?? '') !== (rightFiles[index]?.path ?? '')) return false;
    if ((leftFiles[index]?.reason ?? '') !== (rightFiles[index]?.reason ?? '')) return false;
  }
  for (let index = 0; index < leftSnippets.length; index += 1) {
    if ((leftSnippets[index]?.path ?? '') !== (rightSnippets[index]?.path ?? '')) return false;
    if ((leftSnippets[index]?.excerpt ?? '') !== (rightSnippets[index]?.excerpt ?? '')) return false;
  }
  return true;
}

function parseDirectGoogleWorkspaceIntent(content: string): DirectGoogleWorkspaceIntent | null {
  const text = content.trim();
  if (!text) return null;

  if (/\b(send|draft|compose|reply|forward)\b/i.test(text)) return null;
  if (!MAILBOX_READ_TARGET_PATTERN.test(text)
    && !(MAILBOX_PROVIDER_PATTERN.test(text) && MAILBOX_NOUN_PATTERN.test(text))) {
    return null;
  }
  const count = parseRequestedEmailCount(text);

  const unreadInboxPatterns = [
    /\bcheck\b[\s\S]{0,80}\b(?:gmail|google workspace|inbox|emails?|email|mail|outlook\s+(?:mail|email|emails?|inbox)|(?:microsoft|office)\s+365(?:\s+outlook)?\s+(?:mail|email|emails?|inbox))\b/i,
    /\b(?:show|list)\b[\s\S]{0,80}\b(?:gmail|google workspace|inbox|emails?|email|mail|outlook\s+(?:mail|email|emails?|inbox)|(?:microsoft|office)\s+365(?:\s+outlook)?\s+(?:mail|email|emails?|inbox))\b/i,
    /\b(?:new|latest|recent|unread)\b[\s\S]{0,40}\b(?:gmail|google workspace|emails?|email|mail|inbox|outlook\s+(?:mail|email|emails?|inbox)|(?:microsoft|office)\s+365(?:\s+outlook)?\s+(?:mail|email|emails?|inbox))\b/i,
    /\bany\s+new\s+emails?\b/i,
    /\bwhat(?:'s|\s+is)?\s+(?:new\s+)?in\s+(?:my\s+)?(?:gmail|inbox)\b/i,
    /\bwhat\s+(?:new|recent|unread)\s+emails?\s+do\s+i\s+have\b/i,
  ];

  if (/\b(?:sender|senders|from|who sent)\b/i.test(text)
    && /\b(?:last|latest|recent)\b/i.test(text)
    && /\bemails?|mail\b/i.test(text)) {
    return { kind: 'gmail_recent_senders', count };
  }

  if (/\b(?:last|latest|recent)\b/i.test(text)
    && /\bemails?|mail\b/i.test(text)
    && /\b(?:detail|details|summary|summarize|subject|snippet|snippets)\b/i.test(text)) {
    return { kind: 'gmail_recent_summary', count };
  }

  if (unreadInboxPatterns.some((pattern) => pattern.test(text))) {
    return { kind: 'gmail_unread', count: Math.max(count, 10) };
  }

  return null;
}

function parseRequestedEmailCount(text: string): number {
  const digitMatch = text.match(/\b(?:top|first|last|latest|recent)\s+(\d+)(?:\s+emails?)?\b/i)
    || text.match(/\b(\d+)\s+emails?\b/i);
  if (digitMatch) {
    const parsed = Number(digitMatch[1]);
    if (Number.isFinite(parsed) && parsed > 0) return Math.min(parsed, 10);
  }

  const wordMap: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  };
  const wordMatch = text.match(/\b(?:top|first|last|latest|recent)\s+(one|two|three|four|five|six|seven|eight|nine|ten)(?:\s+emails?)?\b/i)
    || text.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+emails?\b/i);
  if (wordMatch) {
    return wordMap[wordMatch[1].toLowerCase()] ?? 3;
  }

  return 3;
}

function toLLMToolDef(def: import('./tools/types.js').ToolDefinition, locality: 'local' | 'external' = 'external'): import('./tools/types.js').ToolDefinition {
  return {
    name: def.name,
    description: locality === 'local' ? def.description : (def.shortDescription ?? def.description),
    risk: def.risk,
    parameters: def.parameters,
    examples: def.examples,
  };
}

type ProviderRoutePreference = 'local' | 'external' | 'default';

const CATEGORY_NATURAL_LOCALITY: Record<string, 'local' | 'external'> = {
  filesystem: 'local',
  shell: 'local',
  network: 'local',
  system: 'local',
  memory: 'local',
  automation: 'external',
  web: 'external',
  browser: 'external',
  workspace: 'external',
  email: 'external',
  contacts: 'external',
  forum: 'external',
  intel: 'external',
  search: 'external',
};

function computeCategoryDefaults(
  llmConfig: Record<string, { provider?: string; baseUrl?: string }>,
): Record<string, 'local' | 'external'> {
  const hasLocal = Object.values(llmConfig).some((cfg) =>
    !!cfg.provider && isLocalProviderEndpoint(cfg.baseUrl, cfg.provider),
  );
  const hasExternal = Object.values(llmConfig).some((cfg) =>
    !!cfg.provider && !isLocalProviderEndpoint(cfg.baseUrl, cfg.provider),
  );

  const defaults: Record<string, 'local' | 'external'> = {};
  for (const [category, natural] of Object.entries(CATEGORY_NATURAL_LOCALITY)) {
    if (hasLocal && hasExternal) {
      defaults[category] = natural;
    } else if (hasLocal) {
      defaults[category] = 'local';
    } else {
      defaults[category] = 'external';
    }
  }
  return defaults;
}

function resolveToolProviderRouting(
  executedTools: Array<{ name: string; category?: string }>,
  routingMap: Record<string, ProviderRoutePreference> | undefined,
  categoryDefaults?: Record<string, 'local' | 'external'>,
): ProviderRoutePreference {
  const hasRouting = routingMap && Object.keys(routingMap).length > 0;
  const hasDefaults = categoryDefaults && Object.keys(categoryDefaults).length > 0;
  if (!hasRouting && !hasDefaults) return 'default';

  let result: ProviderRoutePreference = 'default';

  for (const tool of executedTools) {
    const toolRoute = routingMap?.[tool.name];
    if (toolRoute && toolRoute !== 'default') {
      if (toolRoute === 'external') return 'external';
      result = toolRoute;
      continue;
    }
    if (tool.category) {
      const catRoute = routingMap?.[tool.category];
      if (catRoute && catRoute !== 'default') {
        if (catRoute === 'external') return 'external';
        if (result === 'default') result = catRoute;
        continue;
      }
      const computedRoute = categoryDefaults?.[tool.category];
      if (computedRoute) {
        if (computedRoute === 'external') return 'external';
        if (result === 'default') result = computedRoute;
      }
    }
  }

  return result;
}

function compactMessagesIfOverBudget(messages: ChatMessage[], budget: number): ContextCompactionResult {
  return _compactMessagesIfOverBudget(messages, budget);
}

function formatToolResultForLLM(toolName: string, toolResult: unknown, threats: string[] = []): string {
  const warningBlock = formatToolThreatWarnings(threats);
  const payloadBudget = Math.max(1_500, MAX_TOOL_RESULT_MESSAGE_CHARS - warningBlock.length - toolName.length - 120);
  const serialized = serializeToolResultForLLM(toolName, toolResult, payloadBudget);
  const envelope = classifyToolResultEnvelope(toolName);

  return [
    `<tool_result name="${escapeToolResultAttribute(toolName)}" source="${envelope.source}" trust="${envelope.trust}">`,
    warningBlock || undefined,
    serialized,
    '</tool_result>',
  ].filter(Boolean).join('\n');
}

function compactQuarantinedToolResult(toolName: string, toolResult: unknown, taintReasons: string[]): Record<string, unknown> {
  const result = toolResult && typeof toolResult === 'object'
    ? toolResult as Record<string, unknown>
    : {};
  return {
    success: result.success === true,
    status: toString(result.status) || 'quarantined',
    message: truncateText(toString(result.message), 300) || `Raw ${toolName} content was quarantined before planner reinjection.`,
    outputPreview: truncateText(safeJsonStringify(compactToolOutputForLLM(toolName, result.output)), 600),
    trustLevel: 'quarantined',
    taintReasons,
    rawContentAvailable: false,
  };
}

function serializeToolResultForLLM(toolName: string, toolResult: unknown, maxChars: number): string {
  const compact = compactToolResultForLLM(toolName, toolResult);
  const serialized = safeJsonStringify(compact);
  if (serialized.length <= maxChars) {
    return serialized;
  }

  const result = toolResult && typeof toolResult === 'object'
    ? toolResult as Record<string, unknown>
    : {};
  return safeJsonStringify({
    success: result.success === true,
    status: toString(result.status),
    message: truncateText(toString(result.message), 400),
    error: truncateText(toString(result.error), 400),
    outputPreview: truncateText(safeJsonStringify(compactToolOutputForLLM(toolName, result.output)), Math.max(600, maxChars - 300)),
    truncated: true,
  });
}

function formatToolThreatWarnings(threats: string[]): string {
  const unique = [...new Set(threats.map((threat) => threat.trim()).filter(Boolean))];
  return unique.slice(0, 4).map((threat) => `[WARNING: ${threat}]`).join('\n');
}

function classifyToolResultEnvelope(toolName: string): { source: 'local' | 'remote'; trust: 'internal' | 'external' } {
  const normalized = toolName.toLowerCase();
  if (/^(web_|chrome_|browser_|mcp-|gws$|gmail_|forum_|campaign_|contacts_)/.test(normalized)) {
    return { source: 'remote', trust: 'external' };
  }
  return { source: 'local', trust: 'internal' };
}

function escapeToolResultAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function compactToolResultForLLM(toolName: string, toolResult: unknown): unknown {
  if (!toolResult || typeof toolResult !== 'object') {
    return compactValueForLLM(toolResult);
  }

  const result = toolResult as Record<string, unknown>;
  return {
    success: result.success,
    status: result.status,
    message: compactValueForLLM(result.message),
    error: compactValueForLLM(result.error),
    approvalId: compactValueForLLM(result.approvalId),
    jobId: compactValueForLLM(result.jobId),
    preview: compactValueForLLM(result.preview),
    output: compactToolOutputForLLM(toolName, result.output),
  };
}

function compactToolOutputForLLM(toolName: string, output: unknown): unknown {
  if (toolName === 'gws') {
    return compactGwsOutputForLLM(output);
  }

  if (output && typeof output === 'object') {
    const obj = output as Record<string, unknown>;

    if ((toolName === 'fs_search' || toolName === 'code_symbol_search') && Array.isArray(obj.matches)) {
      const matches = obj.matches as unknown[];
      return {
        root: truncateText(toString(obj.root), 240) || undefined,
        query: truncateText(toString(obj.query), 200) || undefined,
        mode: truncateText(toString(obj.mode), 40) || undefined,
        scannedDirs: toNumber(obj.scannedDirs) ?? undefined,
        scannedFiles: toNumber(obj.scannedFiles) ?? undefined,
        truncated: toBoolean(obj.truncated),
        matches: matches.slice(0, 20).map((match) => compactFilesystemSearchMatchForLLM(match)),
        ...(matches.length > 20 ? { moreMatches: matches.length - 20 } : {}),
      };
    }

    if (toolName === 'fs_read' && typeof obj.content === 'string') {
      const content = obj.content as string;
      const lines = content.split('\n');
      if (lines.length > 70) {
        const head = lines.slice(0, 50).join('\n');
        const tail = lines.slice(-20).join('\n');
        return { ...obj, content: `${head}\n[... ${lines.length - 70} lines omitted ...]\n${tail}` };
      }
    }

    if (toolName === 'fs_search' && Array.isArray(obj.matches)) {
      const matches = obj.matches as unknown[];
      if (matches.length > 20) {
        return { ...obj, matches: matches.slice(0, 20), moreMatches: matches.length - 20 };
      }
    }

    if (toolName === 'shell_safe' && typeof obj.stdout === 'string') {
      const stdout = obj.stdout as string;
      if (stdout.length > 2048) {
        const lineCount = stdout.split('\n').length;
        return { ...obj, stdout: `[... ${lineCount} lines, showing last 2KB ...]\n${stdout.slice(-2048)}` };
      }
    }

    if (toolName === 'web_fetch' && typeof obj.content === 'string') {
      const content = obj.content as string;
      if (content.length > 3072) {
        return { ...obj, content: content.slice(0, 3072) + '\n[... content truncated ...]' };
      }
    }

    if ((toolName === 'net_arp_scan' || toolName === 'net_connections') && Array.isArray(obj.devices ?? obj.connections)) {
      const items = (obj.devices ?? obj.connections) as unknown[];
      const key = obj.devices ? 'devices' : 'connections';
      if (items.length > 15) {
        return { ...obj, [key]: items.slice(0, 15), totalCount: items.length, moreOmitted: items.length - 15 };
      }
    }
  }

  return compactValueForLLM(output);
}

function compactFilesystemSearchMatchForLLM(match: unknown): Record<string, unknown> {
  if (!match || typeof match !== 'object') {
    return { value: compactValueForLLM(match) };
  }

  const value = match as Record<string, unknown>;
  const relativePath = truncateText(toString(value.relativePath) || toString(value.path), 240) || undefined;
  const matchType = truncateText(toString(value.matchType), 24) || undefined;
  const snippet = truncateText(toString(value.snippet), 240) || undefined;

  return {
    relativePath,
    matchType,
    ...(snippet ? { snippet } : {}),
  };
}

function compactGwsOutputForLLM(output: unknown): unknown {
  if (!output || typeof output !== 'object') {
    return compactValueForLLM(output);
  }

  const value = output as Record<string, unknown>;
  if (Array.isArray(value.messages)) {
    return {
      messages: value.messages.slice(0, MAX_TOOL_RESULT_ARRAY_ITEMS).map((entry) => compactGmailMessageForLLM(entry)),
      resultSizeEstimate: toNumber(value.resultSizeEstimate) ?? undefined,
      nextPageToken: truncateText(toString(value.nextPageToken), 120) || undefined,
    };
  }

  if ('payload' in value || 'snippet' in value || 'labelIds' in value) {
    return compactGmailMessageForLLM(value);
  }

  return compactValueForLLM(output);
}

function compactGmailMessageForLLM(message: unknown): unknown {
  if (!message || typeof message !== 'object') {
    return compactValueForLLM(message);
  }

  const value = message as Record<string, unknown>;
  const payload = value.payload && typeof value.payload === 'object'
    ? value.payload as { headers?: unknown }
    : undefined;
  const headers = Array.isArray(payload?.headers)
    ? payload.headers as Array<{ name?: unknown; value?: unknown }>
    : [];

  return {
    id: truncateText(toString(value.id), 120) || undefined,
    threadId: truncateText(toString(value.threadId), 120) || undefined,
    labelIds: Array.isArray(value.labelIds)
      ? value.labelIds.slice(0, MAX_TOOL_RESULT_ARRAY_ITEMS).map((item) => truncateText(toString(item), 80))
      : undefined,
    internalDate: truncateText(toString(value.internalDate), 120) || undefined,
    sizeEstimate: toNumber(value.sizeEstimate) ?? undefined,
    snippet: truncateText(toString(value.snippet), 400),
    from: findHeaderValue(headers, 'from') || undefined,
    to: findHeaderValue(headers, 'to') || undefined,
    subject: findHeaderValue(headers, 'subject') || undefined,
    date: findHeaderValue(headers, 'date') || undefined,
  };
}

function compactValueForLLM(value: unknown, depth: number = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return truncateText(value, MAX_TOOL_RESULT_STRING_CHARS);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 3) return `[${Array.isArray(value) ? 'Array' : 'Object'} omitted]`;

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_TOOL_RESULT_ARRAY_ITEMS).map((item) => compactValueForLLM(item, depth + 1));
    if (value.length > MAX_TOOL_RESULT_ARRAY_ITEMS) {
      items.push(`[${value.length - MAX_TOOL_RESULT_ARRAY_ITEMS} more items omitted]`);
    }
    return items;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    let kept = 0;
    for (const [key, entryValue] of entries) {
      if (kept >= MAX_TOOL_RESULT_OBJECT_KEYS) break;
      if ((key === 'raw' || key === 'data') && typeof entryValue === 'string') {
        out[key] = `[${key} omitted: ${entryValue.length} chars]`;
      } else if (key === 'parts' && Array.isArray(entryValue)) {
        out[key] = `[${entryValue.length} MIME parts omitted]`;
      } else {
        out[key] = compactValueForLLM(entryValue, depth + 1);
      }
      kept += 1;
    }
    if (entries.length > MAX_TOOL_RESULT_OBJECT_KEYS) {
      out._truncatedKeys = entries.length - MAX_TOOL_RESULT_OBJECT_KEYS;
    }
    return out;
  }

  return String(value);
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return truncateText(String(value), MAX_TOOL_RESULT_MESSAGE_CHARS);
  }
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 16))}[...truncated]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOwnProp(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function trimOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readMessageSurfaceId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return trimOptionalString(value.surfaceId);
}

type ParsedCodeRequestMetadata = {
  workspaceRoot?: string;
  sessionId?: string;
  fileReferences?: CodeSessionFileReferenceInput[];
};

function readCodeRequestMetadata(metadata: unknown): ParsedCodeRequestMetadata | undefined {
  if (!isRecord(metadata)) return undefined;
  const codeContext = metadata.codeContext;
  if (!isRecord(codeContext)) return undefined;
  const workspaceRoot = trimOptionalString(codeContext.workspaceRoot);
  const sessionId = trimOptionalString(codeContext.sessionId);
  const fileReferences = sanitizeCodeSessionFileReferences(codeContext.fileReferences);
  if (!workspaceRoot && !sessionId && fileReferences.length === 0) return undefined;
  return {
    ...(workspaceRoot ? { workspaceRoot } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(fileReferences.length > 0 ? { fileReferences } : {}),
  };
}

function sanitizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && entry.trim()) {
      result[key] = entry.trim();
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function sanitizeNormalizedUrlRecord(value: unknown): Record<string, string> | undefined {
  const sanitized = sanitizeStringRecord(value);
  return sanitized ? normalizeHttpUrlRecord(sanitized) : undefined;
}

function redactCloudConfig(cloud: GuardianAgentConfig['assistant']['tools']['cloud']): RedactedCloudConfig | undefined {
  if (!cloud) return undefined;

  let inlineSecretProfileCount = 0;
  let credentialRefCount = 0;
  let selfSignedProfileCount = 0;
  let customEndpointProfileCount = 0;

  const cpanelProfiles = (cloud.cpanelProfiles ?? []).map((profile) => {
    const normalized = normalizeCpanelConnectionConfig(profile);
    const apiTokenConfigured = !!profile.apiToken?.trim();
    if (apiTokenConfigured) inlineSecretProfileCount += 1;
    if (profile.credentialRef?.trim()) credentialRefCount += 1;
    if (profile.allowSelfSigned) selfSignedProfileCount += 1;
    return {
      id: profile.id,
      name: profile.name,
      type: profile.type,
      host: normalized.host,
      port: normalized.port,
      username: profile.username,
      credentialRef: profile.credentialRef,
      apiTokenConfigured,
      ssl: normalized.ssl !== false,
      allowSelfSigned: profile.allowSelfSigned === true,
      defaultCpanelUser: profile.defaultCpanelUser,
    };
  });

  const vercelProfiles = (cloud.vercelProfiles ?? []).map((profile) => {
    const apiTokenConfigured = !!profile.apiToken?.trim();
    if (apiTokenConfigured) inlineSecretProfileCount += 1;
    if (profile.credentialRef?.trim()) credentialRefCount += 1;
    if (profile.apiBaseUrl?.trim()) customEndpointProfileCount += 1;
    return {
      id: profile.id,
      name: profile.name,
      apiBaseUrl: normalizeOptionalHttpUrlInput(profile.apiBaseUrl),
      credentialRef: profile.credentialRef,
      apiTokenConfigured,
      teamId: profile.teamId,
      slug: profile.slug,
    };
  });

  const cloudflareProfiles = (cloud.cloudflareProfiles ?? []).map((profile) => {
    const apiTokenConfigured = !!profile.apiToken?.trim();
    if (apiTokenConfigured) inlineSecretProfileCount += 1;
    if (profile.credentialRef?.trim()) credentialRefCount += 1;
    if (profile.apiBaseUrl?.trim()) customEndpointProfileCount += 1;
    return {
      id: profile.id,
      name: profile.name,
      apiBaseUrl: normalizeOptionalHttpUrlInput(profile.apiBaseUrl),
      credentialRef: profile.credentialRef,
      apiTokenConfigured,
      accountId: profile.accountId,
      defaultZoneId: profile.defaultZoneId,
    };
  });

  const awsProfiles = (cloud.awsProfiles ?? []).map((profile) => {
    const accessKeyIdConfigured = !!profile.accessKeyId?.trim();
    const secretAccessKeyConfigured = !!profile.secretAccessKey?.trim();
    const sessionTokenConfigured = !!profile.sessionToken?.trim();
    if (accessKeyIdConfigured || secretAccessKeyConfigured || sessionTokenConfigured) inlineSecretProfileCount += 1;
    if (profile.accessKeyIdCredentialRef?.trim()) credentialRefCount += 1;
    if (profile.secretAccessKeyCredentialRef?.trim()) credentialRefCount += 1;
    if (profile.sessionTokenCredentialRef?.trim()) credentialRefCount += 1;
    const endpoints = sanitizeNormalizedUrlRecord(profile.endpoints);
    if (endpoints) customEndpointProfileCount += 1;
    return {
      id: profile.id,
      name: profile.name,
      region: profile.region,
      accessKeyIdCredentialRef: profile.accessKeyIdCredentialRef,
      secretAccessKeyCredentialRef: profile.secretAccessKeyCredentialRef,
      sessionTokenCredentialRef: profile.sessionTokenCredentialRef,
      accessKeyIdConfigured,
      secretAccessKeyConfigured,
      sessionTokenConfigured,
      endpoints,
    };
  });

  const gcpProfiles = (cloud.gcpProfiles ?? []).map((profile) => {
    const accessTokenConfigured = !!profile.accessToken?.trim();
    const serviceAccountConfigured = !!profile.serviceAccountJson?.trim();
    if (accessTokenConfigured || serviceAccountConfigured) inlineSecretProfileCount += 1;
    if (profile.accessTokenCredentialRef?.trim()) credentialRefCount += 1;
    if (profile.serviceAccountCredentialRef?.trim()) credentialRefCount += 1;
    const endpoints = sanitizeNormalizedUrlRecord(profile.endpoints);
    if (endpoints) customEndpointProfileCount += 1;
    return {
      id: profile.id,
      name: profile.name,
      projectId: profile.projectId,
      location: profile.location,
      accessTokenCredentialRef: profile.accessTokenCredentialRef,
      serviceAccountCredentialRef: profile.serviceAccountCredentialRef,
      accessTokenConfigured,
      serviceAccountConfigured,
      endpoints,
    };
  });

  const azureProfiles = (cloud.azureProfiles ?? []).map((profile) => {
    const accessTokenConfigured = !!profile.accessToken?.trim();
    const clientIdConfigured = !!profile.clientId?.trim();
    const clientSecretConfigured = !!profile.clientSecret?.trim();
    if (accessTokenConfigured || clientIdConfigured || clientSecretConfigured) inlineSecretProfileCount += 1;
    if (profile.accessTokenCredentialRef?.trim()) credentialRefCount += 1;
    if (profile.clientIdCredentialRef?.trim()) credentialRefCount += 1;
    if (profile.clientSecretCredentialRef?.trim()) credentialRefCount += 1;
    const endpoints = sanitizeNormalizedUrlRecord(profile.endpoints);
    if (endpoints || profile.blobBaseUrl?.trim()) customEndpointProfileCount += 1;
    return {
      id: profile.id,
      name: profile.name,
      subscriptionId: profile.subscriptionId,
      tenantId: profile.tenantId,
      accessTokenCredentialRef: profile.accessTokenCredentialRef,
      accessTokenConfigured,
      clientIdCredentialRef: profile.clientIdCredentialRef,
      clientIdConfigured,
      clientSecretCredentialRef: profile.clientSecretCredentialRef,
      clientSecretConfigured,
      defaultResourceGroup: profile.defaultResourceGroup,
      blobBaseUrl: normalizeOptionalHttpUrlInput(profile.blobBaseUrl),
      endpoints,
    };
  });

  return {
    enabled: cloud.enabled,
    cpanelProfiles,
    vercelProfiles,
    cloudflareProfiles,
    awsProfiles,
    gcpProfiles,
    azureProfiles,
    profileCounts: {
      cpanel: cpanelProfiles.length,
      vercel: vercelProfiles.length,
      cloudflare: cloudflareProfiles.length,
      aws: awsProfiles.length,
      gcp: gcpProfiles.length,
      azure: azureProfiles.length,
      total: cpanelProfiles.length + vercelProfiles.length + cloudflareProfiles.length + awsProfiles.length + gcpProfiles.length + azureProfiles.length,
    },
    security: {
      inlineSecretProfileCount,
      credentialRefCount,
      selfSignedProfileCount,
      customEndpointProfileCount,
    },
  };
}

function mergeCloudConfigForValidation(
  currentCloud: GuardianAgentConfig['assistant']['tools']['cloud'] | undefined,
  cloudUpdate: NonNullable<NonNullable<NonNullable<ConfigUpdate['assistant']>['tools']>['cloud']>,
): GuardianAgentConfig['assistant']['tools']['cloud'] {
  const current = currentCloud ?? {
    enabled: false,
    cpanelProfiles: [],
    vercelProfiles: [],
    cloudflareProfiles: [],
    awsProfiles: [],
    gcpProfiles: [],
    azureProfiles: [],
  };

  return {
    ...current,
    ...cloudUpdate,
    cpanelProfiles: Array.isArray(cloudUpdate.cpanelProfiles)
      ? cloudUpdate.cpanelProfiles.map((profile) => {
        const existing = current.cpanelProfiles?.find((entry) => entry.id === profile.id);
        return {
          ...existing,
          ...profile,
          apiToken: hasOwnProp(profile, 'apiToken') ? trimOptionalString(profile.apiToken) : existing?.apiToken,
          credentialRef: hasOwnProp(profile, 'credentialRef') ? trimOptionalString(profile.credentialRef) : existing?.credentialRef,
          defaultCpanelUser: hasOwnProp(profile, 'defaultCpanelUser') ? trimOptionalString(profile.defaultCpanelUser) : existing?.defaultCpanelUser,
        };
      })
      : current.cpanelProfiles,
    vercelProfiles: Array.isArray(cloudUpdate.vercelProfiles)
      ? cloudUpdate.vercelProfiles.map((profile) => {
        const existing = current.vercelProfiles?.find((entry) => entry.id === profile.id);
        return {
          ...existing,
          ...profile,
          apiBaseUrl: hasOwnProp(profile, 'apiBaseUrl') ? normalizeOptionalHttpUrlInput(profile.apiBaseUrl) : existing?.apiBaseUrl,
          apiToken: hasOwnProp(profile, 'apiToken') ? trimOptionalString(profile.apiToken) : existing?.apiToken,
          credentialRef: hasOwnProp(profile, 'credentialRef') ? trimOptionalString(profile.credentialRef) : existing?.credentialRef,
          teamId: hasOwnProp(profile, 'teamId') ? trimOptionalString(profile.teamId) : existing?.teamId,
          slug: hasOwnProp(profile, 'slug') ? trimOptionalString(profile.slug) : existing?.slug,
        };
      })
      : current.vercelProfiles,
    cloudflareProfiles: Array.isArray(cloudUpdate.cloudflareProfiles)
      ? cloudUpdate.cloudflareProfiles.map((profile) => {
        const existing = current.cloudflareProfiles?.find((entry) => entry.id === profile.id);
        return {
          ...existing,
          ...profile,
          apiBaseUrl: hasOwnProp(profile, 'apiBaseUrl') ? normalizeOptionalHttpUrlInput(profile.apiBaseUrl) : existing?.apiBaseUrl,
          apiToken: hasOwnProp(profile, 'apiToken') ? trimOptionalString(profile.apiToken) : existing?.apiToken,
          credentialRef: hasOwnProp(profile, 'credentialRef') ? trimOptionalString(profile.credentialRef) : existing?.credentialRef,
          accountId: hasOwnProp(profile, 'accountId') ? trimOptionalString(profile.accountId) : existing?.accountId,
          defaultZoneId: hasOwnProp(profile, 'defaultZoneId') ? trimOptionalString(profile.defaultZoneId) : existing?.defaultZoneId,
        };
      })
      : current.cloudflareProfiles,
    awsProfiles: Array.isArray(cloudUpdate.awsProfiles)
      ? cloudUpdate.awsProfiles.map((profile) => {
        const existing = current.awsProfiles?.find((entry) => entry.id === profile.id);
        return {
          ...existing,
          ...profile,
          accessKeyId: hasOwnProp(profile, 'accessKeyId') ? trimOptionalString(profile.accessKeyId) : existing?.accessKeyId,
          accessKeyIdCredentialRef: hasOwnProp(profile, 'accessKeyIdCredentialRef') ? trimOptionalString(profile.accessKeyIdCredentialRef) : existing?.accessKeyIdCredentialRef,
          secretAccessKey: hasOwnProp(profile, 'secretAccessKey') ? trimOptionalString(profile.secretAccessKey) : existing?.secretAccessKey,
          secretAccessKeyCredentialRef: hasOwnProp(profile, 'secretAccessKeyCredentialRef') ? trimOptionalString(profile.secretAccessKeyCredentialRef) : existing?.secretAccessKeyCredentialRef,
          sessionToken: hasOwnProp(profile, 'sessionToken') ? trimOptionalString(profile.sessionToken) : existing?.sessionToken,
          sessionTokenCredentialRef: hasOwnProp(profile, 'sessionTokenCredentialRef') ? trimOptionalString(profile.sessionTokenCredentialRef) : existing?.sessionTokenCredentialRef,
          endpoints: hasOwnProp(profile, 'endpoints') ? sanitizeNormalizedUrlRecord(profile.endpoints) : existing?.endpoints,
        };
      })
      : current.awsProfiles,
    gcpProfiles: Array.isArray(cloudUpdate.gcpProfiles)
      ? cloudUpdate.gcpProfiles.map((profile) => {
        const existing = current.gcpProfiles?.find((entry) => entry.id === profile.id);
        return {
          ...existing,
          ...profile,
          location: hasOwnProp(profile, 'location') ? trimOptionalString(profile.location) : existing?.location,
          accessToken: hasOwnProp(profile, 'accessToken') ? trimOptionalString(profile.accessToken) : existing?.accessToken,
          accessTokenCredentialRef: hasOwnProp(profile, 'accessTokenCredentialRef') ? trimOptionalString(profile.accessTokenCredentialRef) : existing?.accessTokenCredentialRef,
          serviceAccountJson: hasOwnProp(profile, 'serviceAccountJson') ? trimOptionalString(profile.serviceAccountJson) : existing?.serviceAccountJson,
          serviceAccountCredentialRef: hasOwnProp(profile, 'serviceAccountCredentialRef') ? trimOptionalString(profile.serviceAccountCredentialRef) : existing?.serviceAccountCredentialRef,
          endpoints: hasOwnProp(profile, 'endpoints') ? sanitizeNormalizedUrlRecord(profile.endpoints) : existing?.endpoints,
        };
      })
      : current.gcpProfiles,
    azureProfiles: Array.isArray(cloudUpdate.azureProfiles)
      ? cloudUpdate.azureProfiles.map((profile) => {
        const existing = current.azureProfiles?.find((entry) => entry.id === profile.id);
        return {
          ...existing,
          ...profile,
          tenantId: hasOwnProp(profile, 'tenantId') ? trimOptionalString(profile.tenantId) : existing?.tenantId,
          accessToken: hasOwnProp(profile, 'accessToken') ? trimOptionalString(profile.accessToken) : existing?.accessToken,
          accessTokenCredentialRef: hasOwnProp(profile, 'accessTokenCredentialRef') ? trimOptionalString(profile.accessTokenCredentialRef) : existing?.accessTokenCredentialRef,
          clientId: hasOwnProp(profile, 'clientId') ? trimOptionalString(profile.clientId) : existing?.clientId,
          clientIdCredentialRef: hasOwnProp(profile, 'clientIdCredentialRef') ? trimOptionalString(profile.clientIdCredentialRef) : existing?.clientIdCredentialRef,
          clientSecret: hasOwnProp(profile, 'clientSecret') ? trimOptionalString(profile.clientSecret) : existing?.clientSecret,
          clientSecretCredentialRef: hasOwnProp(profile, 'clientSecretCredentialRef') ? trimOptionalString(profile.clientSecretCredentialRef) : existing?.clientSecretCredentialRef,
          defaultResourceGroup: hasOwnProp(profile, 'defaultResourceGroup') ? trimOptionalString(profile.defaultResourceGroup) : existing?.defaultResourceGroup,
          blobBaseUrl: hasOwnProp(profile, 'blobBaseUrl') ? normalizeOptionalHttpUrlInput(profile.blobBaseUrl) : existing?.blobBaseUrl,
          endpoints: hasOwnProp(profile, 'endpoints') ? sanitizeNormalizedUrlRecord(profile.endpoints) : existing?.endpoints,
        };
      })
      : current.azureProfiles,
  };
}

function redactCodingBackendsConfig(config: GuardianAgentConfig): RedactedConfig['assistant']['tools']['codingBackends'] {
  const defaults = DEFAULT_CODING_BACKENDS_CONFIG;
  const codingBackends = config.assistant.tools.codingBackends ?? defaults;
  const configuredIds = new Set(codingBackends?.backends.map((backend) => backend.id) ?? []);
  const mergedBackends: DashboardCodingBackendInfo[] = [];

  for (const backend of codingBackends?.backends ?? []) {
    const preset = CODING_BACKEND_PRESETS.find((candidate) => candidate.id === backend.id);
    const merged = preset
      ? {
          ...preset,
          enabled: backend.enabled,
          ...(backend.shell ? { shell: backend.shell } : {}),
          ...(backend.env ? { env: { ...backend.env } } : {}),
          ...(typeof backend.timeoutMs === 'number' ? { timeoutMs: backend.timeoutMs } : {}),
          ...(typeof backend.nonInteractive === 'boolean' ? { nonInteractive: backend.nonInteractive } : {}),
          ...(typeof backend.lastVersionCheck === 'number' ? { lastVersionCheck: backend.lastVersionCheck } : {}),
          ...(typeof backend.installedVersion === 'string' ? { installedVersion: backend.installedVersion } : {}),
          ...(typeof backend.updateAvailable === 'boolean' ? { updateAvailable: backend.updateAvailable } : {}),
        }
      : backend;
    mergedBackends.push({
      id: merged.id,
      name: merged.name,
      configured: true,
      preset: !!preset,
      enabled: merged.enabled,
      shell: merged.shell,
      command: merged.command,
      args: [...merged.args],
      versionCommand: merged.versionCommand,
      updateCommand: merged.updateCommand,
      timeoutMs: merged.timeoutMs,
      nonInteractive: merged.nonInteractive,
      envKeys: Object.keys(merged.env ?? {}).sort(),
      installedVersion: merged.installedVersion,
      updateAvailable: merged.updateAvailable,
      lastVersionCheck: merged.lastVersionCheck,
    });
  }

  for (const preset of CODING_BACKEND_PRESETS) {
    if (configuredIds.has(preset.id)) continue;
    mergedBackends.push({
      id: preset.id,
      name: preset.name,
      configured: false,
      preset: true,
      enabled: false,
      shell: preset.shell,
      command: preset.command,
      args: [...preset.args],
      versionCommand: preset.versionCommand,
      updateCommand: preset.updateCommand,
      timeoutMs: preset.timeoutMs,
      nonInteractive: preset.nonInteractive,
      envKeys: [],
    });
  }

  mergedBackends.sort((left, right) => {
    if (left.configured !== right.configured) return left.configured ? -1 : 1;
    if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
    return left.name.localeCompare(right.name);
  });

  return {
    enabled: codingBackends?.enabled ?? false,
    defaultBackend: codingBackends?.defaultBackend,
    maxConcurrentSessions: codingBackends?.maxConcurrentSessions ?? defaults?.maxConcurrentSessions ?? 2,
    autoUpdate: codingBackends?.autoUpdate ?? defaults?.autoUpdate ?? true,
    versionCheckIntervalMs: codingBackends?.versionCheckIntervalMs ?? defaults?.versionCheckIntervalMs ?? 86_400_000,
    backends: mergedBackends,
  };
}

const DEFAULT_CODING_BACKENDS_CONFIG: NonNullable<GuardianAgentConfig['assistant']['tools']['codingBackends']> = DEFAULT_CONFIG.assistant.tools.codingBackends ?? {
  enabled: false,
  backends: [],
  maxConcurrentSessions: 2,
  autoUpdate: true,
  versionCheckIntervalMs: 86_400_000,
};

function redactConfig(config: GuardianAgentConfig): RedactedConfig {
  const llm: Record<string, {
    provider: string;
    model: string;
    baseUrl?: string;
    credentialRef?: string;
    maxTokens?: number;
    temperature?: number;
    timeoutMs?: number;
    keepAlive?: string | number;
    think?: import('./config/types.js').OllamaThinkConfig;
    ollamaOptions?: import('./config/types.js').OllamaOptionsConfig;
  }> = {};
  for (const [name, cfg] of Object.entries(config.llm)) {
    llm[name] = {
      provider: cfg.provider,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      credentialRef: cfg.credentialRef,
      maxTokens: cfg.maxTokens,
      temperature: cfg.temperature,
      timeoutMs: cfg.timeoutMs,
      keepAlive: cfg.keepAlive,
      think: cfg.think,
      ollamaOptions: cfg.ollamaOptions,
    };
  }
  const searchConfig = config.assistant.tools.search;
  const searchSources = Array.isArray(searchConfig?.sources) ? searchConfig.sources : [];

  return {
    llm,
    defaultProvider: config.defaultProvider,
    channels: {
      cli: config.channels.cli ? { enabled: config.channels.cli.enabled } : undefined,
      telegram: config.channels.telegram ? {
        enabled: config.channels.telegram.enabled,
        botTokenConfigured: !!(config.channels.telegram.botToken?.trim() || config.channels.telegram.botTokenCredentialRef?.trim()),
        botTokenCredentialRef: config.channels.telegram.botTokenCredentialRef,
        allowedChatIds: config.channels.telegram.allowedChatIds,
        defaultAgent: config.channels.telegram.defaultAgent,
      } : undefined,
      web: config.channels.web ? {
        enabled: config.channels.web.enabled,
        port: config.channels.web.port,
        host: config.channels.web.host,
        auth: {
          mode: config.channels.web.auth?.mode ?? 'bearer_required',
          tokenConfigured: !!(config.channels.web.auth?.token?.trim() || config.channels.web.authToken?.trim()),
          tokenSource: config.channels.web.auth?.tokenSource,
          rotateOnStartup: config.channels.web.auth?.rotateOnStartup ?? false,
          sessionTtlMinutes: config.channels.web.auth?.sessionTtlMinutes,
        },
      } : undefined,
    },
    guardian: {
      enabled: config.guardian.enabled,
      rateLimit: config.guardian.rateLimit,
      inputSanitization: config.guardian.inputSanitization,
      outputScanning: config.guardian.outputScanning,
      guardianAgent: config.guardian.guardianAgent ? {
        enabled: config.guardian.guardianAgent.enabled,
        llmProvider: config.guardian.guardianAgent.llmProvider,
        failOpen: config.guardian.guardianAgent.failOpen,
        timeoutMs: config.guardian.guardianAgent.timeoutMs,
      } : undefined,
      sentinel: config.guardian.sentinel ? {
        enabled: config.guardian.sentinel.enabled,
        schedule: config.guardian.sentinel.schedule,
      } : undefined,
      policy: config.guardian.policy ? {
        enabled: config.guardian.policy.enabled,
        mode: config.guardian.policy.mode,
        rulesPath: config.guardian.policy.rulesPath,
      } : undefined,
    },
    runtime: config.runtime,
    assistant: {
      setupCompleted: config.assistant.setup.completed,
      identity: {
        mode: config.assistant.identity.mode,
        primaryUserId: config.assistant.identity.primaryUserId,
      },
      soul: {
        enabled: config.assistant.soul.enabled,
        path: config.assistant.soul.path,
        primaryMode: config.assistant.soul.primaryMode,
        delegatedMode: config.assistant.soul.delegatedMode,
        maxChars: config.assistant.soul.maxChars,
        summaryMaxChars: config.assistant.soul.summaryMaxChars,
      },
      memory: {
        enabled: config.assistant.memory.enabled,
        retentionDays: config.assistant.memory.retentionDays,
      },
      analytics: {
        enabled: config.assistant.analytics.enabled,
        retentionDays: config.assistant.analytics.retentionDays,
      },
      notifications: {
        enabled: config.assistant.notifications.enabled,
        minSeverity: config.assistant.notifications.minSeverity,
        auditEventTypes: [...config.assistant.notifications.auditEventTypes],
        suppressedDetailTypes: [...config.assistant.notifications.suppressedDetailTypes],
        cooldownMs: config.assistant.notifications.cooldownMs,
        deliveryMode: config.assistant.notifications.deliveryMode,
        destinations: { ...config.assistant.notifications.destinations },
      },
      quickActions: {
        enabled: config.assistant.quickActions.enabled,
      },
      security: {
        deploymentProfile: config.assistant.security?.deploymentProfile ?? DEFAULT_DEPLOYMENT_PROFILE,
        operatingMode: config.assistant.security?.operatingMode ?? DEFAULT_SECURITY_OPERATING_MODE,
        triageLlmProvider: config.assistant.security?.triageLlmProvider ?? DEFAULT_SECURITY_TRIAGE_LLM_PROVIDER,
        continuousMonitoring: {
          enabled: config.assistant.security?.continuousMonitoring?.enabled !== false,
          profileId: config.assistant.security?.continuousMonitoring?.profileId ?? DEFAULT_ASSISTANT_SECURITY_MONITORING_PROFILE,
          cron: config.assistant.security?.continuousMonitoring?.cron?.trim() || DEFAULT_ASSISTANT_SECURITY_MONITORING_CRON,
        },
        autoContainment: {
          enabled: config.assistant.security?.autoContainment?.enabled !== false,
          minSeverity: config.assistant.security?.autoContainment?.minSeverity ?? DEFAULT_ASSISTANT_SECURITY_AUTO_CONTAINMENT_SEVERITY,
          minConfidence: config.assistant.security?.autoContainment?.minConfidence ?? DEFAULT_ASSISTANT_SECURITY_AUTO_CONTAINMENT_CONFIDENCE,
          categories: [...(config.assistant.security?.autoContainment?.categories ?? DEFAULT_ASSISTANT_SECURITY_AUTO_CONTAINMENT_CATEGORIES)],
        },
      },
      credentials: {
        refs: Object.fromEntries(
          Object.entries(config.assistant.credentials.refs ?? {}).map(([name, ref]) => [name, {
            source: ref.source,
            env: ref.source === 'env' ? ref.env : undefined,
            description: ref.description,
          }]),
        ),
      },
      threatIntel: {
        enabled: config.assistant.threatIntel.enabled,
        allowDarkWeb: config.assistant.threatIntel.allowDarkWeb,
        responseMode: config.assistant.threatIntel.responseMode,
        watchlistCount: config.assistant.threatIntel.watchlist.length,
        autoScanIntervalMinutes: config.assistant.threatIntel.autoScanIntervalMinutes,
        moltbook: {
          enabled: config.assistant.threatIntel.moltbook.enabled,
          mode: config.assistant.threatIntel.moltbook.mode,
          baseUrl: config.assistant.threatIntel.moltbook.baseUrl,
          allowActiveResponse: config.assistant.threatIntel.moltbook.allowActiveResponse,
        },
      },
      network: {
        deviceIntelligence: {
          enabled: config.assistant.network.deviceIntelligence.enabled,
          ouiDatabase: config.assistant.network.deviceIntelligence.ouiDatabase,
          autoClassify: config.assistant.network.deviceIntelligence.autoClassify,
        },
        baseline: {
          enabled: config.assistant.network.baseline.enabled,
          minSnapshotsForBaseline: config.assistant.network.baseline.minSnapshotsForBaseline,
          dedupeWindowMs: config.assistant.network.baseline.dedupeWindowMs,
        },
        fingerprinting: {
          enabled: config.assistant.network.fingerprinting.enabled,
          bannerTimeout: config.assistant.network.fingerprinting.bannerTimeout,
          maxConcurrentPerDevice: config.assistant.network.fingerprinting.maxConcurrentPerDevice,
          autoFingerprint: config.assistant.network.fingerprinting.autoFingerprint,
        },
        wifi: {
          enabled: config.assistant.network.wifi.enabled,
          platform: config.assistant.network.wifi.platform,
          scanInterval: config.assistant.network.wifi.scanInterval,
        },
        trafficAnalysis: {
          enabled: config.assistant.network.trafficAnalysis.enabled,
          dataSource: config.assistant.network.trafficAnalysis.dataSource,
          flowRetention: config.assistant.network.trafficAnalysis.flowRetention,
        },
        connectionCount: config.assistant.network.connections.length,
      },
      hostMonitoring: {
        enabled: config.assistant.hostMonitoring.enabled,
        scanIntervalSec: config.assistant.hostMonitoring.scanIntervalSec,
        dedupeWindowMs: config.assistant.hostMonitoring.dedupeWindowMs,
        monitorProcesses: config.assistant.hostMonitoring.monitorProcesses,
        monitorPersistence: config.assistant.hostMonitoring.monitorPersistence,
        monitorSensitivePaths: config.assistant.hostMonitoring.monitorSensitivePaths,
        monitorNetwork: config.assistant.hostMonitoring.monitorNetwork,
        monitorFirewall: config.assistant.hostMonitoring.monitorFirewall,
        sensitivePathCount: config.assistant.hostMonitoring.sensitivePaths.length,
        suspiciousProcessCount: config.assistant.hostMonitoring.suspiciousProcessNames.length,
      },
      gatewayMonitoring: {
        enabled: config.assistant.gatewayMonitoring.enabled,
        scanIntervalSec: config.assistant.gatewayMonitoring.scanIntervalSec,
        dedupeWindowMs: config.assistant.gatewayMonitoring.dedupeWindowMs,
        monitorCount: config.assistant.gatewayMonitoring.monitors.filter((monitor) => monitor.enabled).length,
      },
      connectors: {
        enabled: config.assistant.connectors.enabled,
        executionMode: config.assistant.connectors.executionMode,
        maxConnectorCallsPerRun: config.assistant.connectors.maxConnectorCallsPerRun,
        packCount: config.assistant.connectors.packs.length,
        enabledPackCount: config.assistant.connectors.packs.filter((pack) => pack.enabled).length,
        playbookCount: config.assistant.connectors.playbooks.definitions.length,
        playbooks: {
          enabled: config.assistant.connectors.playbooks.enabled,
          maxSteps: config.assistant.connectors.playbooks.maxSteps,
          maxParallelSteps: config.assistant.connectors.playbooks.maxParallelSteps,
          defaultStepTimeoutMs: config.assistant.connectors.playbooks.defaultStepTimeoutMs,
          requireSignedDefinitions: config.assistant.connectors.playbooks.requireSignedDefinitions,
          requireDryRunOnFirstExecution: config.assistant.connectors.playbooks.requireDryRunOnFirstExecution,
        },
        studio: {
          enabled: config.assistant.connectors.studio.enabled,
          mode: config.assistant.connectors.studio.mode,
          requirePrivilegedTicket: config.assistant.connectors.studio.requirePrivilegedTicket,
        },
      },
      tools: {
        enabled: config.assistant.tools.enabled,
        policyMode: config.assistant.tools.policyMode,
        allowExternalPosting: config.assistant.tools.allowExternalPosting,
        allowedPathsCount: config.assistant.tools.allowedPaths.length,
        allowedCommandsCount: config.assistant.tools.allowedCommands.length,
        allowedDomainsCount: config.assistant.tools.allowedDomains.length,
        allowedDomains: [...config.assistant.tools.allowedDomains],
        preferredProviders: config.assistant.tools.preferredProviders,
        webSearch: {
          provider: config.assistant.tools.webSearch?.provider ?? 'auto',
          perplexityConfigured: !!(config.assistant.tools.webSearch?.perplexityApiKey || config.assistant.tools.webSearch?.perplexityCredentialRef),
          perplexityCredentialRef: config.assistant.tools.webSearch?.perplexityCredentialRef,
          openRouterConfigured: !!(config.assistant.tools.webSearch?.openRouterApiKey || config.assistant.tools.webSearch?.openRouterCredentialRef),
          openRouterCredentialRef: config.assistant.tools.webSearch?.openRouterCredentialRef,
          braveConfigured: !!(config.assistant.tools.webSearch?.braveApiKey || config.assistant.tools.webSearch?.braveCredentialRef),
          braveCredentialRef: config.assistant.tools.webSearch?.braveCredentialRef,
        },
        search: searchConfig ? {
          enabled: searchConfig.enabled,
          sourceCount: searchSources.length,
          defaultMode: searchConfig.defaultMode ?? 'keyword',
        } : undefined,
        sandbox: {
          enforcementMode: config.assistant.tools.sandbox?.enforcementMode ?? 'permissive',
          degradedFallback: resolveDegradedFallbackConfig(config.assistant.tools.sandbox),
        },
        browser: {
          enabled: config.assistant.tools.browser?.enabled ?? true,
          allowedDomains: config.assistant.tools.browser?.allowedDomains ?? config.assistant.tools.allowedDomains,
          playwrightEnabled: config.assistant.tools.browser?.playwrightEnabled ?? true,
          playwrightBrowser: config.assistant.tools.browser?.playwrightBrowser ?? 'chromium',
          playwrightCaps: config.assistant.tools.browser?.playwrightCaps ?? 'network,storage',
        },
        codingBackends: redactCodingBackendsConfig(config),
        cloud: redactCloudConfig(config.assistant.tools.cloud),
        agentPolicyUpdates: config.assistant.tools.agentPolicyUpdates,
      },
    },
    fallbacks: config.fallbacks,
  };
}

export {
  DEFAULT_CODING_BACKENDS_CONFIG,
  buildCodeSessionTaggedFilePromptContext,
  buildCodeSessionWorkspaceAwarenessQuery,
  compactMessagesIfOverBudget,
  compactQuarantinedToolResult,
  computeCategoryDefaults,
  formatDirectFilesystemSearchResponse,
  formatDirectCodeSessionLine,
  formatToolThreatWarnings,
  formatToolResultForLLM,
  getCodeSessionPromptRelativePath,
  isAffirmativeContinuation,
  isRecord,
  mergeCloudConfigForValidation,
  normalizeCodingBackendSelection,
  normalizeScheduledEmailBody,
  parseDirectGoogleWorkspaceIntent,
  readCodeRequestMetadata,
  readMessageSurfaceId,
  redactConfig,
  resolveToolProviderRouting,
  sameCodeWorkspaceWorkingSet,
  sanitizeNormalizedUrlRecord,
  shouldRefreshCodeSessionFocus,
  shouldRefreshCodeSessionWorkingSet,
  stripLeadingContextPrefix,
  summarizeCodeSessionFocus,
  summarizeGmailMessage,
  summarizeM365From,
  summarizeToolRoundFallback,
  toBoolean,
  toLLMToolDef,
  toNumber,
  toString,
};

export type { GmailMessageSummary, ParsedCodeRequestMetadata };
