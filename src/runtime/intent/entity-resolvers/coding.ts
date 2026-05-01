import type { IntentGatewayEntities, IntentGatewayOperation } from '../types.js';
import { collapseIntentGatewayWhitespace } from '../text.js';

const REMOTE_SANDBOX_REQUEST_PATTERN = /\b(?:remote|cloud|isolated|managed)\s+sandbox\b/i;
const NAMED_REMOTE_SANDBOX_REQUEST_PATTERN = /\b(?:using|with|via)\s+(?:the\s+)?(?:existing\s+|current\s+|managed\s+)?[a-z0-9][a-z0-9._ -]*?\s+sandbox\b/i;
const EXPLICIT_REMOTE_PROFILE_PATTERN = /\bprofileid\s+([a-z0-9._:-]+)/i;
const NAMED_REMOTE_PROFILE_PATTERN = /\b(?:using|with|via)\s+(?:the\s+)?([a-z0-9][a-z0-9._ -]*?)\s+profile\b/i;
const REMOTE_SANDBOX_ACTION_PATTERN = /\b(?:run|execute|create|write|read|open|install|test|build|lint|check|restart|resume|reuse|continue|report|verify|cat|show)\b/i;
const MANAGED_SANDBOX_STATUS_PATTERN = /\bdaytona\b[^.!?\n]{0,80}\b(?:status|health|reachable|reachability|connectivity|diagnostics?)\b|\b(?:status|health|reachable|reachability|connectivity|diagnostics?)\b[^.!?\n]{0,80}\bdaytona\b/i;
const REMOTE_SANDBOX_STATUS_PATTERN = /\b(?:remote|cloud|isolated|managed)\s+sandboxes?\b[^.!?\n]{0,80}\b(?:status|health|reachable|reachability|connectivity|diagnostics?)\b|\b(?:status|health|reachable|reachability|connectivity|diagnostics?)\b[^.!?\n]{0,80}\b(?:remote|cloud|isolated|managed)\s+sandboxes?\b/i;
const FILESYSTEM_SCOPE_PATTERN = /\b(?:workspace|directory|folder|path|paths|file|files|repo\s+root|project\s+root|current\s+directory)\b/i;

const GENERIC_SESSION_TARGET_TOKENS = new Set([
  'a',
  'active',
  'an',
  'attached',
  'cloud',
  'current',
  'currently',
  'for',
  'from',
  'in',
  'isolated',
  'the',
  'my',
  'of',
  'on',
  'remote',
  'sandbox',
  'this',
  'that',
  'using',
  'via',
  'workspace',
  'workspaces',
  'session',
  'sessions',
  'coding',
  'code',
  'project',
  'repo',
  'repository',
]);

export function inferExplicitCodingBackendRequest(
  rawContent: string,
  normalized: string,
  parsedOperation: IntentGatewayOperation,
): {
  codingBackend: string;
  operation: IntentGatewayOperation;
  sessionTarget?: string;
} | null {
  const codingBackend = inferRequestedCodingBackend(normalized);
  if (!codingBackend) return null;
  const operation = parsedOperation !== 'unknown'
    ? parsedOperation
    : inferExplicitCodingBackendOperation(normalized);
  if (!operation || operation === 'unknown') {
    return null;
  }
  const sessionTarget = extractCodingWorkspaceTarget(rawContent);
  return {
    codingBackend,
    operation,
    ...(sessionTarget ? { sessionTarget } : {}),
  };
}

export function inferRequestedCodingBackend(normalized: string): string | undefined {
  if (!normalized) return undefined;
  if (
    isNegatedCodingBackendMention(normalized, '(?:openai\\s+)?codex(?:\\s+(?:cli|coding assistant|assistant))?')
  ) {
    return undefined;
  }
  if (/\b(?:use|using|with|via|run|launch|start|ask|delegate\s+to)\s+(?:the\s+)?(?:openai\s+)?codex(?:\s+(?:cli|coding assistant|assistant))?\b/.test(normalized)) {
    return 'codex';
  }
  if (
    isNegatedCodingBackendMention(normalized, 'claude(?:\\s+code)?(?:\\s+(?:cli|coding assistant|assistant))?')
  ) {
    return undefined;
  }
  if (/\b(?:use|using|with|via|run|launch|start|ask|delegate\s+to)\s+(?:the\s+)?claude(?:\s+code)?(?:\s+(?:cli|coding assistant|assistant))?\b/.test(normalized)) {
    return 'claude-code';
  }
  if (
    isNegatedCodingBackendMention(normalized, 'gemini(?:\\s+cli)?(?:\\s+(?:coding assistant|assistant))?')
  ) {
    return undefined;
  }
  if (/\b(?:use|using|with|via|run|launch|start|ask|delegate\s+to)\s+(?:the\s+)?gemini(?:\s+cli)?(?:\s+(?:coding assistant|assistant))?\b/.test(normalized)) {
    return 'gemini-cli';
  }
  if (
    isNegatedCodingBackendMention(normalized, 'aider(?:\\s+(?:coding assistant|assistant))?')
  ) {
    return undefined;
  }
  if (/\b(?:use|using|with|via|run|launch|start|ask|delegate\s+to)\s+(?:the\s+)?aider(?:\s+(?:coding assistant|assistant))?\b/.test(normalized)) {
    return 'aider';
  }
  return undefined;
}

function isNegatedCodingBackendMention(normalized: string, backendPattern: string): boolean {
  const pattern = new RegExp(
    `\\b(?:do\\s+not|don't|dont|without|instead\\s+of|avoid)\\s+(?:using\\s+|use\\s+)?(?:the\\s+)?${backendPattern}\\b`,
  );
  return pattern.test(normalized);
}

export function inferExplicitCodingBackendOperation(
  normalized: string,
): IntentGatewayOperation | null {
  if (!normalized) return null;
  if (/\b(?:create|add|make|write|implement|build|generate)\b/.test(normalized)) {
    return 'create';
  }
  if (/\b(?:update|edit|change|modify|fix|refactor|rename|patch)\b/.test(normalized)) {
    return 'update';
  }
  if (/\b(?:delete|remove)\b/.test(normalized)) {
    return 'delete';
  }
  if (/\b(?:search|find|grep|rg)\b/.test(normalized)) {
    return 'search';
  }
  if (
    /\b(?:inspect|review|audit|analy[sz]e|check|evaluate|debug|investigate|explain|plan)\b/.test(normalized)
    || /\blook\s+at\b/.test(normalized)
  ) {
    return 'inspect';
  }
  if (/\b(?:read|show|open)\b/.test(normalized)) {
    return 'read';
  }
  return 'run';
}

export function extractCodingWorkspaceTarget(rawContent: string): string | undefined {
  if (!rawContent) return undefined;
  const patterns = [
    /\b(?:switch|attach|use|change\s+to|connect)\s+(?:this\s+chat\s+)?(?:to\s+)?(?:the\s+)?(?:coding\s+)?(?:workspace|session)\s+(?:for|named|called)\s+(.+?)$/i,
    /\b(?:in|within)\s+(?:the\s+)?(.+?)\s+(?:coding workspace|coding session|workspace|session|repo(?:sitory)?|project)\b/i,
    /\b(?:for|against)\s+(?:the\s+)?(.+?)\s+(?:coding workspace|coding session|workspace|session|repo(?:sitory)?|project)\b/i,
  ];
  for (const pattern of patterns) {
    const match = rawContent.match(pattern);
    const cleaned = cleanInferredSessionTarget(match?.[1]);
    if (cleaned) {
      return cleaned;
    }
  }
  return undefined;
}

export function inferCodeSessionControlOperation(
  normalized: string,
): IntentGatewayOperation | null {
  if (!normalized) return null;
  if (isManagedSandboxStatusInspectionRequest(normalized, normalized)) {
    return 'inspect';
  }
  if (/\b(?:switch|attach|use|change\s+to|connect)\b/.test(normalized)) {
    return 'update';
  }
  if (/\b(?:detach|disconnect|leave)\b/.test(normalized)) {
    return 'delete';
  }
  if (/\b(?:create|new|start)\b/.test(normalized)) {
    return 'create';
  }
  if (
    /\b(?:list|show|display|view)\b.*\b(?:coding\s+)?(?:sessions?|workspaces?)\b/.test(normalized)
    || /\b(?:all|available|other)\b.*\b(?:coding\s+)?(?:sessions?|workspaces?)\b/.test(normalized)
  ) {
    return 'navigate';
  }
  if (/\b(?:current|active|attached|what|which)\b.*\b(?:coding\s+)?(?:session|workspace)\b/.test(normalized)) {
    return 'inspect';
  }
  return null;
}

export function extractExplicitRepoFilePath(rawContent: string): string | undefined {
  if (!rawContent) return undefined;
  const patterns = [
    /\b([A-Za-z]:\\(?:[^\\\s"'`]+\\)*[^\\\s"'`]+\.[A-Za-z0-9]+)\b/,
    /\b((?:\.{1,2}\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)\b/,
    /\b([A-Za-z]:\\(?:[^\\\s"'`]+\\)*[^\\\s"'`\\]+\\?)\b/,
    /\b((?:\.{1,2}[\\/])?(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+(?:[\\/])?)\b/,
    /\b([A-Za-z0-9_.-]+\.[A-Za-z0-9]+)\b/,
  ];
  for (const pattern of patterns) {
    const match = rawContent.match(pattern);
    const candidate = match?.[1]?.trim();
    if (candidate) {
      const cleaned = candidate.replace(/[.,;:!?]+$/, '');
      if (cleaned.includes('://')) {
        continue;
      }
      return cleaned;
    }
  }
  return undefined;
}

export function resolveExplicitRemoteProfileId(rawContent: string): string | undefined {
  if (!rawContent) return undefined;
  const explicitMatch = rawContent.match(EXPLICIT_REMOTE_PROFILE_PATTERN);
  if (explicitMatch?.[1]?.trim()) {
    return explicitMatch[1].trim().replace(/[)"'\].,!?;]+$/g, '');
  }
  const namedMatch = rawContent.match(NAMED_REMOTE_PROFILE_PATTERN);
  const namedProfile = (namedMatch?.[1]?.trim() || '').replace(/[)"'\].,!?;]+$/g, '');
  return namedProfile || undefined;
}

export function hasExplicitRemoteSandboxReference(rawContent: string, normalized: string): boolean {
  if (!rawContent || !normalized) return false;
  return REMOTE_SANDBOX_REQUEST_PATTERN.test(normalized)
    || NAMED_REMOTE_SANDBOX_REQUEST_PATTERN.test(rawContent)
    || !!resolveExplicitRemoteProfileId(rawContent);
}

export function isExplicitRemoteSandboxTaskRequest(
  rawContent: string,
  normalized: string,
): boolean {
  if (!hasExplicitRemoteSandboxReference(rawContent, normalized)) {
    return false;
  }
  return REMOTE_SANDBOX_ACTION_PATTERN.test(normalized)
    || hasExplicitRepoPathReference(normalized);
}

export function isManagedSandboxStatusInspectionRequest(
  rawContent: string,
  normalized: string,
): boolean {
  const source = normalized || rawContent.toLowerCase();
  if (!rawContent || !source) return false;
  return MANAGED_SANDBOX_STATUS_PATTERN.test(source)
    || REMOTE_SANDBOX_STATUS_PATTERN.test(source);
}

export function extractExplicitRemoteExecCommand(
  rawContent: string,
  normalized: string,
  operation: IntentGatewayOperation,
): string | undefined {
  if (!rawContent || !normalized) return undefined;
  if (operation !== 'run') return undefined;
  if (!hasExplicitRemoteSandboxReference(rawContent, normalized)) return undefined;

  const runMatch = rawContent.match(/\b[Rr]un\s+(.+?)\s+in\s+(?:the\s+)?(?:remote|isolated|cloud|managed)\s+sandbox\b/)
    ?? rawContent.match(/\b[Rr]un\s+(.+?)\s+using\s+(?:the\s+)?[a-z0-9][a-z0-9._ -]*?\s+profile\b/i)
    ?? rawContent.match(/\b[Rr]un\s+(.+?)\s+using\s+(?:the\s+)?(?:existing\s+|current\s+|managed\s+)?[a-z0-9][a-z0-9._ -]*?\s+sandbox\b/i);
  const command = collapseIntentGatewayWhitespace(runMatch?.[1] ?? '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
  return command || undefined;
}

export function inferCodeSessionResource(
  normalized: string,
): IntentGatewayEntities['codeSessionResource'] | undefined {
  if (!normalized) return undefined;
  if (
    /\bsandboxes?\b/.test(normalized)
    || isManagedSandboxStatusInspectionRequest(normalized, normalized)
  ) {
    return 'managed_sandboxes';
  }
  if (
    /\b(?:list|show|display|view)\b.*\b(?:coding\s+)?(?:sessions?|workspaces?)\b/.test(normalized)
    || /\b(?:all|available|other)\b.*\b(?:coding\s+)?(?:sessions?|workspaces?)\b/.test(normalized)
    || /\b(?:coding\s+)?(?:sessions?|workspaces?)\b.*\b(?:available|listed|there)\b/.test(normalized)
  ) {
    return 'session_list';
  }
  return undefined;
}

export function inferCodeSessionSandboxProvider(
  normalized: string,
): IntentGatewayEntities['codeSessionSandboxProvider'] | undefined {
  if (!normalized || !isManagedSandboxStatusInspectionRequest(normalized, normalized)) {
    return undefined;
  }
  if (/\bdaytona\b/.test(normalized)) {
    return 'daytona';
  }
  if (/\bvercel\b/.test(normalized)) {
    return 'vercel';
  }
  return 'all';
}

export function cleanInferredSessionTarget(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = collapseIntentGatewayWhitespace(value)
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^[Tt]he\s+/, '')
    .replace(/^(?:remote|isolated|cloud)\s+sandbox\s+(?:for|against|using)\s+/i, '')
    .replace(/^[Tt]he\s+/, '')
    .replace(/[.,!?;:]+$/g, '')
    .trim();
  if (!cleaned) return undefined;
  const tokenCount = cleaned.split(/\s+/g).filter(Boolean).length;
  if (tokenCount > 6) return undefined;
  if (/[,;:]/.test(cleaned)) return undefined;
  if (/^(?:what|which|who|whom|whose|where|when|why|how)\b/i.test(cleaned)) return undefined;
  const semanticTokens = extractSessionTargetSemanticTokens(cleaned);
  if (semanticTokens.length === 0) {
    return undefined;
  }
  return cleaned;
}

export function normalizeSessionTargetSemanticKey(value: string | undefined): string | undefined {
  const cleaned = cleanInferredSessionTarget(value);
  if (!cleaned) return undefined;
  const semanticTokens = extractSessionTargetSemanticTokens(cleaned);
  return semanticTokens.length > 0 ? semanticTokens.join(' ') : undefined;
}

export function areEquivalentSessionTargets(left: string | undefined, right: string | undefined): boolean {
  const leftKey = normalizeSessionTargetSemanticKey(left);
  const rightKey = normalizeSessionTargetSemanticKey(right);
  return !!leftKey && leftKey === rightKey;
}

export function inferExplicitCodingTaskOperation(
  normalized: string,
  parsedOperation: IntentGatewayOperation,
): IntentGatewayOperation | null {
  if (!normalized || !hasExplicitRepoFileReference(normalized)) return null;
  if (parsedOperation && parsedOperation !== 'unknown') return parsedOperation;
  if (/\b(?:create|add|make|write|generate|touch)\b/.test(normalized)) {
    return 'create';
  }
  if (/\b(?:update|edit|change|modify|fix|patch|rewrite|append)\b/.test(normalized)) {
    return 'update';
  }
  if (/\b(?:delete|remove)\b/.test(normalized)) {
    return 'delete';
  }
  if (
    /\b(?:run|execute|start|watch)\b/.test(normalized)
    && /\b(?:tests?|test suite|unit tests?|build|compile|lint|check)\b/.test(normalized)
  ) {
    return 'run';
  }
  if (
    /\b(?:npm|pnpm|yarn|bun|npx|vitest|jest|pytest|cargo|go|dotnet|mvn|gradle)\b/.test(normalized)
    && /\b(?:test|build|lint|check|run)\b/.test(normalized)
  ) {
    return 'run';
  }
  if (/\b(?:search|find|grep|rg)\b/.test(normalized)) {
    return 'search';
  }
  if (
    /\b(?:inspect|review|audit|analy[sz]e|check|evaluate)\b/.test(normalized)
    || /\blook\s+at\b/.test(normalized)
    || /\b(?:risk|risks|regression|regressions|security|approval-bypass|privilege-escalation)\b/.test(normalized)
  ) {
    return 'inspect';
  }
  if (/\b(?:read|show|open)\b/.test(normalized)) {
    return 'read';
  }
  return null;
}

function extractSessionTargetSemanticTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean)
    .filter((token) => !GENERIC_SESSION_TARGET_TOKENS.has(token));
}

export function inferExplicitFilesystemTaskOperation(
  normalized: string,
  parsedOperation: IntentGatewayOperation,
): IntentGatewayOperation | null {
  if (!normalized) return null;
  const hasFilesystemScope = hasExplicitRepoPathReference(normalized)
    || FILESYSTEM_SCOPE_PATTERN.test(normalized);
  if (!hasFilesystemScope) return null;
  const inferredOperation = inferFilesystemOperationFromVerbs(normalized);
  if (!inferredOperation) {
    return parsedOperation && parsedOperation !== 'unknown' ? parsedOperation : null;
  }
  if (!parsedOperation || parsedOperation === 'unknown') {
    return inferredOperation;
  }
  const parsedIsMutating = parsedOperation === 'create'
    || parsedOperation === 'update'
    || parsedOperation === 'delete'
    || parsedOperation === 'save';
  const inferredIsMutating = inferredOperation === 'create'
    || inferredOperation === 'update'
    || inferredOperation === 'delete'
    || inferredOperation === 'save';
  if (!parsedIsMutating && inferredIsMutating) {
    return inferredOperation;
  }
  return parsedOperation;
}

export function hasExplicitRepoFileReference(normalized: string): boolean {
  return /(?:\b[a-z]:\\(?:[^\\\s]+\\)*[^\\\s]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|txt|csv|log|toml|ini|py|rs|go|java|rb|php|sh|ya?ml)\b)|(?:\b(?:[a-z0-9_.-]+\/)+[a-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|txt|csv|log|toml|ini|py|rs|go|java|rb|php|sh|ya?ml)\b)/i.test(normalized);
}

export function hasExplicitRepoPathReference(normalized: string): boolean {
  return hasExplicitRepoFileReference(normalized)
    || /(?:\b[a-z]:\\(?:[^\\\s"'`]+\\)+[^\\\s"'`\\]+\b)|(?:\b(?:\.{1,2}[\\/])?(?:[a-z0-9_.-]+[\\/])+[a-z0-9_.-]+(?:[\\/])?\b)/i.test(normalized);
}

function inferFilesystemOperationFromVerbs(normalized: string): IntentGatewayOperation | null {
  if (/\b(?:save|store|export)\b/.test(normalized)) {
    return 'save';
  }
  if (/\b(?:create|add|make|write|put|touch|mkdir)\b/.test(normalized)) {
    return 'create';
  }
  if (/\b(?:update|edit|change|modify|append|rename|move|copy)\b/.test(normalized)) {
    return 'update';
  }
  if (/\b(?:delete|remove)\b/.test(normalized)) {
    return 'delete';
  }
  if (/\b(?:search|find|locate|grep|rg)\b/.test(normalized)) {
    return 'search';
  }
  if (/\b(?:read|open|show|list|display|cat)\b/.test(normalized)) {
    return 'read';
  }
  return null;
}
