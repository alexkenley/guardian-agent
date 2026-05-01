import type { UserMessage } from '../../agent/types.js';
import type { ContentTrustLevel } from '../../tools/types.js';

export type ToolMessageSecurityContext = {
  contentTrustLevel?: ContentTrustLevel;
  taintReasons?: string[];
  derivedFromTaintedContent?: boolean;
};

export function readToolMessageSecurityContext(
  message: UserMessage,
  sourceMessage?: UserMessage,
): ToolMessageSecurityContext {
  const sources = [sourceMessage?.metadata, message.metadata].filter(isRecord);
  let contentTrustLevel: ContentTrustLevel | undefined;
  const taintReasons = new Set<string>();
  let derivedFromTaintedContent = false;

  for (const source of sources) {
    const candidates = [
      source,
      isRecord(source.security) ? source.security : null,
      isRecord(source.contentSecurity) ? source.contentSecurity : null,
    ].filter(isRecord);
    for (const candidate of candidates) {
      contentTrustLevel = mergeContentTrustLevel(
        contentTrustLevel,
        normalizeContentTrustLevel(candidate.contentTrustLevel),
      );
      if (candidate.derivedFromTaintedContent === true) {
        derivedFromTaintedContent = true;
      }
      if (Array.isArray(candidate.taintReasons)) {
        for (const reason of candidate.taintReasons) {
          const normalized = typeof reason === 'string' ? reason.trim() : '';
          if (normalized) taintReasons.add(normalized);
        }
      }
    }
  }

  return {
    ...(contentTrustLevel ? { contentTrustLevel } : {}),
    ...(taintReasons.size > 0 ? { taintReasons: [...taintReasons] } : {}),
    ...(derivedFromTaintedContent ? { derivedFromTaintedContent: true } : {}),
  };
}

function normalizeContentTrustLevel(value: unknown): ContentTrustLevel | undefined {
  return value === 'trusted' || value === 'low_trust' || value === 'quarantined'
    ? value
    : undefined;
}

function mergeContentTrustLevel(
  current: ContentTrustLevel | undefined,
  next: ContentTrustLevel | undefined,
): ContentTrustLevel | undefined {
  if (!next) return current;
  if (!current) return next;
  if (current === 'quarantined' || next === 'quarantined') return 'quarantined';
  if (current === 'low_trust' || next === 'low_trust') return 'low_trust';
  return 'trusted';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
