/**
 * Helpers for detecting direct filesystem search requests in free-form chat.
 */

import type { ToolPolicySnapshot } from '../tools/types.js';

export interface DirectFileSearchIntent {
  path: string;
  query: string;
}

export function parseDirectFileSearchIntent(
  content: string,
  policy: ToolPolicySnapshot,
): DirectFileSearchIntent | null {
  const text = content.trim();
  if (!text) return null;
  if (!/\b(search|find|locate|look\s+for)\b/i.test(text)) return null;
  if (!/\b(file|folder|directory|path|onedrive|drive)\b/i.test(text)) return null;

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

  return null;
}

export function extractSearchQuery(text: string): string | null {
  const quoted = text.match(/["']([^"']{2,120})["']/);
  if (quoted?.[1]) return quoted[1].trim();

  const forMatch = text.match(/\bfor\s+(.+?)(?:\s+\b(?:in|inside|within|under)\b|$)/i);
  const candidate = (forMatch?.[1] ?? '').trim().replace(/[.,;:!?]+$/, '');
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
