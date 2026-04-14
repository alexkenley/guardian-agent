import type { IntentGatewayOperation } from '../types.js';
import { collapseIntentGatewayWhitespace } from '../text.js';

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
  if (/\b(?:use|using|with|via|run|launch|start|ask|delegate\s+to)\s+(?:the\s+)?(?:openai\s+)?codex(?:\s+(?:cli|coding assistant|assistant))?\b/.test(normalized)) {
    return 'codex';
  }
  if (/\b(?:use|using|with|via|run|launch|start|ask|delegate\s+to)\s+(?:the\s+)?claude(?:\s+code)?(?:\s+(?:cli|coding assistant|assistant))?\b/.test(normalized)) {
    return 'claude-code';
  }
  if (/\b(?:use|using|with|via|run|launch|start|ask|delegate\s+to)\s+(?:the\s+)?gemini(?:\s+cli)?(?:\s+(?:coding assistant|assistant))?\b/.test(normalized)) {
    return 'gemini-cli';
  }
  if (/\b(?:use|using|with|via|run|launch|start|ask|delegate\s+to)\s+(?:the\s+)?aider(?:\s+(?:coding assistant|assistant))?\b/.test(normalized)) {
    return 'aider';
  }
  return undefined;
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

export function extractExplicitRemoteExecCommand(
  rawContent: string,
  normalized: string,
  operation: IntentGatewayOperation,
): string | undefined {
  if (!rawContent || !normalized) return undefined;
  if (operation !== 'run') return undefined;
  if (!/\b(?:remote|isolated|cloud)\s+sandbox\b/.test(normalized)) return undefined;

  const runMatch = rawContent.match(/\b[Rr]un\s+(.+?)\s+in\s+(?:the\s+)?(?:remote|isolated|cloud)\s+sandbox\b/);
  const command = collapseIntentGatewayWhitespace(runMatch?.[1] ?? '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
  return command || undefined;
}

export function cleanInferredSessionTarget(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = collapseIntentGatewayWhitespace(value)
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^[Tt]he\s+/, '')
    .replace(/[.,!?;:]+$/g, '')
    .trim();
  if (!cleaned) return undefined;
  const semanticTokens = cleaned
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean)
    .filter((token) => !GENERIC_SESSION_TARGET_TOKENS.has(token));
  if (semanticTokens.length === 0) {
    return undefined;
  }
  return cleaned;
}

export function inferExplicitCodingTaskOperation(
  normalized: string,
  parsedOperation: IntentGatewayOperation,
): IntentGatewayOperation | null {
  if (!normalized || !hasExplicitRepoFileReference(normalized)) return null;
  if (parsedOperation && parsedOperation !== 'unknown') return parsedOperation;
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

export function hasExplicitRepoFileReference(normalized: string): boolean {
  return /(?:\b[a-z]:\\(?:[^\\\s]+\\)*[^\\\s]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|rs|go|java|rb|php|sh|ya?ml)\b)|(?:\b(?:[a-z0-9_.-]+\/)+[a-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|rs|go|java|rb|php|sh|ya?ml)\b)/i.test(normalized);
}
