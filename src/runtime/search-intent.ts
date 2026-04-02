/**
 * Helpers for detecting direct filesystem search requests in free-form chat.
 */

import type { ToolPolicySnapshot } from '../tools/types.js';

export interface DirectFileSearchIntent {
  path: string;
  query: string;
}

interface DirectFileSearchIntentOptions {
  fallbackPath?: string;
}

export function isDirectBrowserAutomationIntent(content: string): boolean {
  const text = content.trim();
  if (!text || text.length < 5) return false;

  const hasUrl = /\bhttps?:\/\/\S+/i.test(text);
  const hasBrowserToolName = /\bbrowser_(?:capabilities|navigate|read|links|extract|state|act|interact)\b/i.test(text);
  const hasBrowserAction = /\b(open|go\s+to|goto|navigate|visit|load|read|click|type|fill|select|submit|list|extract|summari[sz]e|show)\b/i.test(text);
  const hasBrowserContext = /\b(browser|page|current page|this page|website|web page|form|link|links|button|input|field|interactive elements|metadata|semantic outline)\b/i.test(text);

  if (hasBrowserToolName) return true;
  if (!hasUrl) {
    return /\b(?:current page|this page)\b/i.test(text) && hasBrowserAction;
  }

  return hasBrowserAction || hasBrowserContext;
}

/**
 * Detect web search intent from free-form user messages.
 * Returns a search query string, or null if the message isn't a web search request.
 * Conservative by design: only trigger for explicit web-search language
 * or strong internet-oriented keywords to avoid hijacking normal chat.
 */
export function parseWebSearchIntent(content: string): string | null {
  const text = content.trim();
  if (!text || text.length < 5) return null;

  if (isDirectBrowserAutomationIntent(text)) {
    return null;
  }

  // Must NOT be a filesystem search (those are handled by parseDirectFileSearchIntent)
  if (/\b(file|folder|directory|path|onedrive|drive|\.txt|\.json|\.ts|\.js|\.py)\b/i.test(text)) {
    return null;
  }

  if (/^(?:hi|hello|hey)\b/i.test(text)) return null;
  if (/^(?:who|what)\s+are\s+you\b/i.test(text)) return null;

  const explicitSearchPatterns = [
    /^(?:please\s+)?(?:search|find|look\s*up|google|browse)\b/i,
    /\b(?:search|look\s*up|google|browse)\b.*\b(?:web|internet|online)\b/i,
    /\bon\s+the\s+(?:web|internet|online)\b/i,
    /\bweb\s+search\b/i,
  ];
  const hasExplicitSignal = explicitSearchPatterns.some((pattern) => pattern.test(text));

  const hasInternetTopicSignal = /\b(?:latest|news|weather|price|stock|market|review|release\s+date|breaking)\b/i.test(text);
  const hasQuestionSignal = /[?]|\b(?:what|who|where|when|how)\b/i.test(text);
  if (!hasExplicitSignal && !(hasInternetTopicSignal && hasQuestionSignal)) return null;

  const query = text
    .replace(/^(?:please|can you|could you|help me|i need to|i want to)\s+/i, '')
    .replace(/^(?:search|find|look\s*up|google|browse)\s+(?:for\s+|the\s+web\s+for\s+)?/i, '')
    .replace(/\s+on\s+the\s+(?:web|internet|online)\s*$/i, '')
    .trim();

  return query.length >= 3 ? query : null;
}

export function parseDirectFileSearchIntent(
  content: string,
  policy: ToolPolicySnapshot,
  options: DirectFileSearchIntentOptions = {},
): DirectFileSearchIntent | null {
  const text = content.trim();
  if (!text) return null;
  if (!/\b(search|find|locate|look\s+for)\b/i.test(text)) return null;
  if (!/\b(file|folder|directory|path|onedrive|drive|workspace|repo|repository|project|codebase)\b/i.test(text)) return null;

  const query = extractSearchQuery(text);
  if (!query) return null;

  const explicitPath = extractPathHint(text);
  if (explicitPath) {
    return { path: explicitPath, query };
  }

  if (/onedrive/i.test(text)) {
    const onedriveRoot = policy.sandbox.allowedPaths.find((value) => /onedrive/i.test(value));
    if (onedriveRoot) {
      return { path: onedriveRoot, query };
    }
  }

  if (options.fallbackPath && /\b(workspace|repo|repository|project|codebase)\b/i.test(text)) {
    return { path: options.fallbackPath, query };
  }

  return null;
}

export function extractSearchQuery(text: string): string | null {
  const quoted = text.match(/["']([^"']{2,120})["']/);
  if (quoted?.[1]) return quoted[1].trim();

  const forMatch = text.match(/\bfor\s+(.+?)(?=\s+\b(?:in|inside|within|under|and\s+(?:tell|show|list|summari[sz]e|explain|report)|then\s+(?:tell|show|list|summari[sz]e|explain|report))\b|$)/i);
  const candidate = (forMatch?.[1] ?? '')
    .trim()
    .replace(/[.,;:!?]+$/, '');
  if (candidate.length >= 2) return candidate;
  return null;
}

export function extractPathHint(text: string): string | null {
  const patterns = [
    /\b(?:in|inside|within|under|path)\s+([A-Za-z]:[\\/][^\n\r"'`]+?)(?=\s+\bfor\b\s+["']|["']|$)/i,
    /\b(?:in|inside|within|under|path)\s+(\/[^\n\r"'`]+?)(?=\s+\bfor\b\s+["']|["']|$)/i,
    /([A-Za-z]:[\\/][^\n\r"'`]+?)(?=\s+\bfor\b\s+["']|["']|$)/,
    /(\/mnt\/[A-Za-z]\/[^\n\r"'`]+?)(?=\s+\bfor\b\s+["']|["']|$)/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const cleaned = sanitizePathHint(match?.[1]);
    if (cleaned) return cleaned;
  }
  return null;
}

export function sanitizePathHint(value: string | undefined): string | null {
  if (!value) return null;
  let cleaned = value.trim().replace(/[.,;:!?]+$/, '');
  cleaned = cleaned.replace(/\s+\b(?:for|with|where)\b$/i, '').trim();
  return cleaned.length >= 3 ? cleaned : null;
}
