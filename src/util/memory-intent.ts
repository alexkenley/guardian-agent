type MemoryMutationToolClass = 'direct_write' | 'elevated';

interface ConversationTurnLike {
  role: 'user' | 'assistant';
  content: string;
}

export interface DirectMemorySaveIntent {
  scope: 'global' | 'code_session';
  content: string;
}

export interface DirectMemoryReadIntent {
  mode: 'search' | 'recall';
  query?: string;
  scope?: 'global' | 'code_session' | 'both';
  separateScopes: boolean;
  labelSources: boolean;
}

const MODEL_MEMORY_MUTATION_TOOL_CLASSES = new Map<string, MemoryMutationToolClass>([
  ['memory_save', 'direct_write'],
  ['memory_import', 'elevated'],
]);

/**
 * Detect whether a tool mutates durable memory state.
 *
 * The current runtime only exposes memory_save, but future memory mutation tools
 * should register here so the outer planner intent gate and executor checks stay aligned.
 */
export function isMemoryMutationToolName(toolName: string): boolean {
  return MODEL_MEMORY_MUTATION_TOOL_CLASSES.has(toolName.trim());
}

export function getMemoryMutationToolClass(toolName: string): MemoryMutationToolClass | null {
  return MODEL_MEMORY_MUTATION_TOOL_CLASSES.get(toolName.trim()) ?? null;
}

export function isDirectMemoryMutationToolName(toolName: string): boolean {
  return getMemoryMutationToolClass(toolName) === 'direct_write';
}

export function isElevatedMemoryMutationToolName(toolName: string): boolean {
  return getMemoryMutationToolClass(toolName) === 'elevated';
}

/**
 * Detect whether the user's message explicitly asks to save/remember something,
 * which is the only case where model-authored memory mutations are allowed today.
 */
export function shouldAllowModelMemoryMutation(content: string): boolean {
  const lower = content.trim().toLowerCase();
  if (!lower) return false;
  return /\b(remember|memory_save|save (?:this|that|it|these|those|fact|preference|note)|store (?:this|that|it|these|those|fact|preference|note)|keep (?:this|that|it) (?:for later|in mind)|note (?:this|that|it)|commit (?:this|that|it) to memory)\b/.test(lower);
}

export function isDirectMemorySaveRequest(content: string): boolean {
  const lower = content.trim().toLowerCase();
  if (!lower) return false;
  if (/^(?:please\s+)?(?:for this (?:coding|code) session only[,:\s-]*)?remember\b/.test(lower)) return true;
  if (/^(?:please\s+)?save\b/.test(lower) && /\b(?:memory|for later|in mind)\b/.test(lower)) return true;
  if (/^(?:please\s+)?store\b/.test(lower) && /\b(?:memory|for later|in mind)\b/.test(lower)) return true;
  if (/^(?:please\s+)?note\b/.test(lower) && /\b(?:memory|for later|in mind)\b/.test(lower)) return true;
  if (/^(?:please\s+)?keep\b/.test(lower) && /\b(?:for later|in mind)\b/.test(lower)) return true;
  return false;
}

export function parseDirectMemorySaveRequest(content: string): DirectMemorySaveIntent | null {
  const trimmed = content.trim();
  if (!trimmed || !isDirectMemorySaveRequest(trimmed)) {
    return null;
  }

  const scope = inferDirectMemorySaveScope(trimmed);
  let normalized = trimmed.replace(/^(?:please\s+)?/i, '');
  normalized = normalized.replace(/^for this (?:coding|code) session only[,:\s-]*/i, '');

  if (/^remember\b/i.test(normalized)) {
    normalized = normalized.replace(/^remember\b/i, '').trim();
  } else if (/^(?:save|store|note)\b/i.test(normalized)) {
    normalized = normalized.replace(/^(?:save|store|note)\b/i, '').trim();
  } else if (/^keep\b/i.test(normalized)) {
    normalized = normalized.replace(/^keep\b/i, '').trim();
  }

  normalized = stripLeadingMemoryScopeDirective(normalized);
  normalized = normalized.replace(/^that\s+/i, '');
  normalized = normalized.replace(/^(?:this|that|it)\s+(?=(?:to|in)\s+(?:global\s+memory|(?:code(?:-| )session|coding session)\s+memory)\b)/i, '');
  normalized = normalized.replace(/^(?:to|in)\s+(?:global\s+memory|(?:code(?:-| )session|coding session)\s+memory)\b[:,]?\s*/i, '');
  normalized = stripTrailingMemoryStorageDirective(normalized);
  normalized = stripTrailingMemoryScopeDirective(normalized);
  normalized = stripTrailingResponseDirective(normalized);
  normalized = stripWrappingQuotes(normalized.trim());

  if (!normalized) return null;
  if (/^(?:this|that|it)(?:\s+to\s+memory(?:\s+(?:for later|in mind))?)?[.!?]*$/i.test(normalized)) {
    return null;
  }
  if (/^(?:to|in)\s+memory(?:\s+(?:for later|in mind))?[.!?]*$/i.test(normalized)) {
    return null;
  }

  return { scope, content: normalized };
}

export function parseDirectMemoryReadRequest(content: string): DirectMemoryReadIntent | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();
  const isRememberAbout = /^what do you remember about\b/.test(lower);
  const isSearchMemory = /^(?:search|find)\b/.test(lower) && /\bmemory\b/.test(lower);
  const isRecallMemory = /^recall\b/.test(lower) && /\bmemory\b/.test(lower);
  const isShowMemory = /^(?:show|list)\b/.test(lower) && /\bmemory\b/.test(lower);
  if (!isRememberAbout && !isSearchMemory && !isRecallMemory && !isShowMemory) {
    return null;
  }

  const scope = inferDirectMemoryReadScope(trimmed);
  const separateScopes = /\bseparately\b/.test(lower);
  const labelSources = /\blabel\b.*\bscope\b/.test(lower) || /\bwhich scope\b/.test(lower);

  let query: string | undefined;
  if (isRememberAbout) {
    query = trimmed.replace(/^what do you remember about\b/i, '').trim();
  } else {
    const forMatch = trimmed.match(/\bfor\b\s+([\s\S]+)$/i);
    if (forMatch?.[1]) {
      query = forMatch[1].trim();
    } else if (isSearchMemory) {
      query = trimmed
        .replace(/^(?:search|find)\b/i, '')
        .replace(/\bpersistent memory\b/i, '')
        .replace(/\bmemory\b/i, '')
        .replace(/^across both scopes\b/i, '')
        .replace(/^across global and code-session memory\b/i, '')
        .trim();
    }
  }

  query = stripWrappingQuotes(stripTrailingMemoryReadDirective((query ?? '').trim()))
    .replace(/\s*,?\s+(?:and\s+)?(?:reply|respond|answer|return)\b[\s\S]*$/i, '')
    .replace(/[?!.]+$/g, '')
    .trim() || undefined;

  return {
    mode: query ? 'search' : 'recall',
    ...(query ? { query } : {}),
    ...(scope ? { scope } : {}),
    separateScopes,
    labelSources,
  };
}

export function resolveAffirmativeMemoryContinuationFromHistory(
  content: string,
  history: ConversationTurnLike[],
): string | null {
  const lower = content.trim().toLowerCase();
  if (!/^(?:ok|okay|yes|yep|yeah|sure|please do|go ahead|do it|proceed|approved)\b/.test(lower)) {
    return null;
  }

  let lastAssistantIndex = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry.role !== 'assistant') continue;
    if (!looksLikeMemoryConfirmationPrompt(entry.content)) continue;
    lastAssistantIndex = index;
    break;
  }
  if (lastAssistantIndex < 0) return null;

  for (let index = lastAssistantIndex - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry.role !== 'user') continue;
    if (!isDirectMemorySaveRequest(entry.content)) continue;
    return entry.content.trim();
  }
  return null;
}

/**
 * Backward-compatible alias for older call sites.
 */
export function shouldAllowImplicitMemorySave(content: string): boolean {
  return shouldAllowModelMemoryMutation(content);
}

export function getMemoryMutationIntentDeniedMessage(toolName: string): string {
  if (isDirectMemoryMutationToolName(toolName)) {
    return 'memory_save is reserved for explicit remember/save requests from the user.';
  }
  return `${toolName} is reserved for explicit user-directed memory changes.`;
}

function looksLikeMemoryConfirmationPrompt(content: string): boolean {
  const lower = content.trim().toLowerCase();
  if (!lower) return false;
  if (/(?:would you like|do you want) me to (?:store|save|remember)\b/.test(lower)) return true;
  return /\b(?:store|save|remember)\b/.test(lower) && /\bmemory\b/.test(lower);
}

function inferDirectMemorySaveScope(content: string): DirectMemorySaveIntent['scope'] {
  const lower = content.trim().toLowerCase();
  if (
    /\b(?:for this (?:coding|code) session only|for this session only)\b/.test(lower)
    || /\b(?:code(?:-| )session|coding session)\s+memory\b/.test(lower)
    || /\bnot global\b/.test(lower)
  ) {
    return 'code_session';
  }
  if (/\b(?:globally|global\s+memory)\b/.test(lower)) {
    return 'global';
  }
  return 'global';
}

function inferDirectMemoryReadScope(content: string): DirectMemoryReadIntent['scope'] | undefined {
  const lower = content.trim().toLowerCase();
  const mentionsGlobal = /\b(?:global memory|globally)\b/.test(lower);
  const mentionsCodeSession = /\b(?:code(?:-| )session|coding session) memory\b/.test(lower);
  if (mentionsGlobal && mentionsCodeSession) return 'both';
  if (/\bboth scopes\b/.test(lower)) return 'both';
  if (mentionsCodeSession) return 'code_session';
  if (mentionsGlobal) return 'global';
  return undefined;
}

function stripLeadingMemoryScopeDirective(content: string): string {
  return content.replace(
    /^(?:globally|(?:in|to)\s+global\s+memory|for this (?:coding|code) session only|for this session only|(?:in|to)\s+(?:code(?:-| )session|coding session)\s+memory)\b[:,]?\s*/i,
    '',
  );
}

function stripTrailingMemoryScopeDirective(content: string): string {
  return content.replace(
    /\s+(?:globally|(?:in|to)\s+global\s+memory|for this (?:coding|code) session only|for this session only|(?:in|to)\s+(?:code(?:-| )session|coding session)\s+memory)(?:,\s*not global)?[.!?]*$/i,
    '',
  ).trim();
}

function stripTrailingMemoryStorageDirective(content: string): string {
  return content.replace(
    /(?:^|[.!?]\s+)(?:save|store)\s+it\s+(?:to|in)\s+(?:global\s+memory|(?:code(?:-| )session|coding session)\s+memory)(?:,\s*not global)?[.!?]*$/i,
    '',
  ).trim();
}

function stripTrailingMemoryReadDirective(content: string): string {
  return content
    .replace(/\s*,?\s*(?:and\s+)?label\s+which\s+scope\s+(?:each\s+)?result\s+came\s+from[.!?]*$/i, '')
    .replace(/\s*,?\s*(?:and\s+)?show\s+which\s+scope\s+(?:each\s+)?result\s+came\s+from[.!?]*$/i, '')
    .replace(/\s*,?\s*separately[.!?]*$/i, '')
    .trim();
}

function stripTrailingResponseDirective(content: string): string {
  return content.replace(
    /(?:[.!?]\s+|,\s*(?:and\s+)?)(?:reply|respond|answer|return)\b[\s\S]*$/i,
    '',
  ).trim();
}

function stripWrappingQuotes(content: string): string {
  return content.replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, '').trim();
}
