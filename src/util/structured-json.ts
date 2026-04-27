import type { ToolCall, ToolDefinition } from '../llm/types.js';

export type StructuredJsonRepairFlag =
  | 'markdown_fence'
  | 'smart_quotes'
  | 'outer_json_extraction'
  | 'trailing_commas'
  | 'python_literals'
  | 'single_quotes'
  | 'control_chars'
  | 'provider_tool_tokens';

export interface StructuredJsonParseResult<T = unknown> {
  value: T;
  extractedText: string;
  flags: StructuredJsonRepairFlag[];
  repaired: boolean;
  confidence: 'high' | 'medium' | 'low';
}

export interface RecoveredToolCallSet {
  toolCalls: ToolCall[];
  flags: StructuredJsonRepairFlag[];
  confidence: 'high' | 'medium' | 'low';
  repaired: boolean;
}

interface JsonCandidate {
  text: string;
  flags: StructuredJsonRepairFlag[];
}

type ToolCallLike = {
  id: string;
  name: string;
  arguments?: string;
};

export function parseStructuredJsonObject<T extends Record<string, unknown>>(content: string): T | null {
  return parseStructuredJsonObjectDetailed<T>(content)?.value ?? null;
}

export function parseStructuredJsonObjectDetailed<T extends Record<string, unknown>>(
  content: string,
): StructuredJsonParseResult<T> | null {
  const parsed = parseStructuredJsonValueDetailed(content);
  if (!parsed || !isRecord(parsed.value)) return null;
  return {
    ...parsed,
    value: parsed.value as T,
  };
}

export function parseStructuredJsonValueDetailed<T = unknown>(
  content: string,
): StructuredJsonParseResult<T> | null {
  const normalized = normalizeStructuredJsonText(content);
  const trimmed = normalized.trim();
  if (!trimmed) return null;

  const seen = new Set<string>();
  const candidates: JsonCandidate[] = [];
  const baseFlags: StructuredJsonRepairFlag[] = normalized === content
    ? []
    : ['smart_quotes'];

  pushCandidate(candidates, seen, trimmed, baseFlags);

  const unfenced = stripMarkdownJsonFence(trimmed);
  if (unfenced !== trimmed) {
    pushCandidate(candidates, seen, unfenced, [...baseFlags, 'markdown_fence']);
  }

  const extracted = extractStructuredJsonValue(unfenced);
  if (extracted && extracted !== unfenced) {
    pushCandidate(
      candidates,
      seen,
      extracted,
      [
        ...baseFlags,
        ...(unfenced !== trimmed ? ['markdown_fence' as const] : []),
        'outer_json_extraction',
      ],
    );
  }

  const extractedFromTrimmed = extractStructuredJsonValue(trimmed);
  if (extractedFromTrimmed && extractedFromTrimmed !== trimmed) {
    pushCandidate(candidates, seen, extractedFromTrimmed, [...baseFlags, 'outer_json_extraction']);
  }

  for (const candidate of candidates) {
    const parsed = parseCandidate(candidate);
    if (parsed) return parsed as StructuredJsonParseResult<T>;
  }

  return null;
}

export function recoverToolCallsFromStructuredText(
  content: string,
  availableTools: ReadonlyArray<Pick<ToolDefinition, 'name'>>,
): RecoveredToolCallSet | null {
  const toolNames = new Set(
    availableTools
      .map((tool) => tool.name.trim())
      .filter(Boolean),
  );
  if (toolNames.size === 0) return null;

  const parsed = parseStructuredJsonValueDetailed(content);
  if (!parsed) {
    return recoverProviderTokenToolCalls(content, toolNames);
  }

  const normalizedCalls = normalizeRecoveredToolCalls(parsed.value, toolNames);
  if (normalizedCalls.length === 0) {
    return recoverProviderTokenToolCalls(content, toolNames);
  }

  return {
    toolCalls: normalizedCalls.map((call, index) => ({
      id: `recovered-tool-call-${index + 1}`,
      name: call.name,
      arguments: call.arguments,
    })),
    flags: parsed.flags,
    confidence: parsed.confidence,
    repaired: parsed.repaired,
  };
}

export function normalizeToolCallsForExecution(
  toolCalls: ToolCall[] | undefined,
  availableTools?: ReadonlyArray<Pick<ToolDefinition, 'name'>>,
): ToolCall[] | undefined;
export function normalizeToolCallsForExecution<T extends ToolCallLike>(
  toolCalls: T[] | undefined,
  availableTools?: ReadonlyArray<Pick<ToolDefinition, 'name'>>,
): Array<T & { arguments: string }> | undefined;
export function normalizeToolCallsForExecution<T extends ToolCallLike>(
  toolCalls: T[] | undefined,
  availableTools?: ReadonlyArray<Pick<ToolDefinition, 'name'>>,
): Array<T & { arguments: string }> | undefined {
  if (!toolCalls?.length) return toolCalls as Array<T & { arguments: string }> | undefined;
  const allowedToolNames = availableTools?.length
    ? new Set(
        availableTools
          .map((tool) => tool.name.trim())
          .filter(Boolean),
      )
    : undefined;
  return toolCalls.map((toolCall) => normalizeToolCallForExecution(toolCall, allowedToolNames) as T & { arguments: string });
}

function pushCandidate(
  candidates: JsonCandidate[],
  seen: Set<string>,
  text: string,
  flags: StructuredJsonRepairFlag[],
): void {
  const normalized = text.trim();
  if (!normalized || seen.has(normalized)) return;
  seen.add(normalized);
  candidates.push({ text: normalized, flags });
}

function parseCandidate(candidate: JsonCandidate): StructuredJsonParseResult<unknown> | null {
  const direct = tryParseJson(candidate.text);
  if (direct !== null) {
    return finalizeParseResult(direct, candidate.text, candidate.flags);
  }

  let working = candidate.text;
  const flags = [...candidate.flags];

  const controlCharsRemoved = stripUnsafeControlCharacters(working);
  if (controlCharsRemoved !== working) {
    working = controlCharsRemoved;
    if (!flags.includes('control_chars')) {
      flags.push('control_chars');
    }
  }

  const withoutTrailingCommas = removeTrailingCommas(working);
  if (withoutTrailingCommas !== working) {
    working = withoutTrailingCommas;
    if (!flags.includes('trailing_commas')) {
      flags.push('trailing_commas');
    }
  }

  const withJsonLiterals = normalizeJsonLikeLiterals(working);
  if (withJsonLiterals !== working) {
    working = withJsonLiterals;
    if (!flags.includes('python_literals')) {
      flags.push('python_literals');
    }
  }

  if (shouldNormalizeSingleQuotes(working)) {
    const normalizedQuotes = working.replace(/'/g, '"');
    if (normalizedQuotes !== working) {
      working = normalizedQuotes;
      if (!flags.includes('single_quotes')) {
        flags.push('single_quotes');
      }
    }
  }

  const repaired = tryParseJson(working);
  if (repaired === null) return null;
  return finalizeParseResult(repaired, working, flags);
}

function finalizeParseResult(
  value: unknown,
  extractedText: string,
  flags: StructuredJsonRepairFlag[],
): StructuredJsonParseResult<unknown> {
  return {
    value,
    extractedText,
    flags,
    repaired: flags.length > 0,
    confidence: classifyConfidence(flags),
  };
}

function tryParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function stripMarkdownJsonFence(content: string): string {
  const fenced = content.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() || content;
}

function normalizeStructuredJsonText(content: string): string {
  return content
    .replace(/^\uFEFF/, '')
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, '\'');
}

function stripUnsafeControlCharacters(content: string): string {
  return content
    .split('')
    .filter((character) => !isUnsafeControlCharacter(character))
    .join('');
}

function isUnsafeControlCharacter(character: string): boolean {
  if (!character) return false;
  const code = character.charCodeAt(0);
  return (code >= 0x00 && code <= 0x1f && character !== '\n' && character !== '\r' && character !== '\t')
    || code === 0x7f;
}

function removeTrailingCommas(content: string): string {
  let current = content;
  while (true) {
    const next = current.replace(/,(\s*[}\]])/g, '$1');
    if (next === current) return next;
    current = next;
  }
}

function normalizeJsonLikeLiterals(content: string): string {
  return content
    .replace(/:\s*True(?=\s*[,}\]])/g, ': true')
    .replace(/:\s*False(?=\s*[,}\]])/g, ': false')
    .replace(/:\s*None(?=\s*[,}\]])/g, ': null')
    .replace(/\[\s*True(?=\s*[,}\]])/g, '[ true')
    .replace(/\[\s*False(?=\s*[,}\]])/g, '[ false')
    .replace(/\[\s*None(?=\s*[,}\]])/g, '[ null')
    .replace(/,\s*True(?=\s*[,}\]])/g, ', true')
    .replace(/,\s*False(?=\s*[,}\]])/g, ', false')
    .replace(/,\s*None(?=\s*[,}\]])/g, ', null');
}

function shouldNormalizeSingleQuotes(content: string): boolean {
  return content.includes('\'') && !content.includes('"');
}

function classifyConfidence(flags: StructuredJsonRepairFlag[]): 'high' | 'medium' | 'low' {
  if (flags.length === 0) return 'high';
  if (flags.some((flag) => (
    flag === 'single_quotes'
    || flag === 'trailing_commas'
    || flag === 'python_literals'
    || flag === 'control_chars'
  ))) {
    return 'low';
  }
  return 'medium';
}

function extractStructuredJsonValue(content: string): string | null {
  const objectStart = content.indexOf('{');
  const arrayStart = content.indexOf('[');
  const start = earliestNonNegative(objectStart, arrayStart);
  if (start < 0) return null;

  const openChar = content[start];
  const closeChar = openChar === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = start; index < content.length; index += 1) {
    const character = content[index];
    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (character === '\\') {
        escaping = true;
        continue;
      }
      if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === openChar) {
      depth += 1;
      continue;
    }
    if (character === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return content.slice(start, index + 1);
      }
    }
  }

  return null;
}

function earliestNonNegative(...values: number[]): number {
  const filtered = values.filter((value) => value >= 0);
  if (filtered.length === 0) return -1;
  return Math.min(...filtered);
}

function normalizeRecoveredToolCalls(
  value: unknown,
  allowedToolNames?: ReadonlySet<string>,
): Array<{ name: string; arguments: string }> {
  const candidateEntries = collectRecoveredToolCallEntries(value);
  const recovered: Array<{ name: string; arguments: string }> = [];

  for (const entry of candidateEntries) {
    const functionRecord = isRecord(entry.function) ? entry.function : null;
    const name = firstNonEmptyString(
      typeof entry.name === 'string' ? entry.name : undefined,
      typeof entry.tool === 'string' ? entry.tool : undefined,
      typeof entry.toolName === 'string' ? entry.toolName : undefined,
      typeof functionRecord?.name === 'string' ? functionRecord.name : undefined,
    );
    if (!name) continue;
    if (allowedToolNames && allowedToolNames.size > 0 && !allowedToolNames.has(name)) continue;

    const rawArguments = entry.arguments ?? entry.args ?? functionRecord?.arguments ?? {};
    recovered.push({
      name,
      arguments: serializeRecoveredToolArguments(rawArguments),
    });
  }

  return recovered;
}

function recoverProviderTokenToolCalls(
  content: string,
  allowedToolNames: ReadonlySet<string>,
): RecoveredToolCallSet | null {
  if (!content.includes('<|tool_call_begin|>') || !content.includes('<|tool_call_argument_begin|>')) {
    return null;
  }

  const recovered: Array<{ name: string; arguments: string }> = [];
  const callPattern = /<\|tool_call_begin\|>\s*(?:functions\.)?([A-Za-z0-9_.-]+)(?::\d+)?\s*<\|tool_call_argument_begin\|>/g;
  let match: RegExpExecArray | null;
  while ((match = callPattern.exec(content)) !== null) {
    const rawName = match[1]?.trim() ?? '';
    const name = normalizeProviderTokenToolName(rawName);
    if (!name || !allowedToolNames.has(name)) continue;

    const argsStart = callPattern.lastIndex;
    const argsEnd = findProviderTokenToolCallEnd(content, argsStart);
    const argsText = content.slice(argsStart, argsEnd).trim();
    const parsedArgs = parseStructuredJsonValueDetailed(argsText);
    if (!parsedArgs) continue;
    recovered.push({
      name,
      arguments: serializeRecoveredToolArguments(parsedArgs.value),
    });
  }

  if (recovered.length === 0) return null;
  return {
    toolCalls: recovered.map((call, index) => ({
      id: `recovered-tool-call-${index + 1}`,
      name: call.name,
      arguments: call.arguments,
    })),
    flags: ['provider_tool_tokens'],
    confidence: 'medium',
    repaired: true,
  };
}

function normalizeProviderTokenToolName(rawName: string): string {
  return rawName.trim().replace(/^functions\./, '');
}

function findProviderTokenToolCallEnd(content: string, startIndex: number): number {
  const endPattern = /<\|tool_call_end\|>|<\|tool_calls_section_end\|>|<\|tool_call_begin\|>/g;
  endPattern.lastIndex = startIndex;
  const endMatch = endPattern.exec(content);
  return endMatch?.index ?? content.length;
}

function normalizeToolCallForExecution(
  toolCall: ToolCallLike,
  allowedToolNames?: ReadonlySet<string>,
): ToolCallLike & { arguments: string } {
  const trimmedName = toolCall.name.trim();
  const trimmedArguments = typeof toolCall.arguments === 'string'
    ? toolCall.arguments.trim()
    : '';
  const recovered = recoverToolCallFromMalformedField(trimmedName, allowedToolNames)
    ?? recoverToolCallFromMalformedField(trimmedArguments, allowedToolNames);
  if (!recovered) {
    return {
      ...toolCall,
      name: trimmedName,
      arguments: trimmedArguments,
    };
  }

  return {
    ...toolCall,
    name: recovered.name,
    arguments: mergeRecoveredToolArguments(trimmedArguments, recovered.arguments),
  };
}

function recoverToolCallFromMalformedField(
  value: string,
  allowedToolNames?: ReadonlySet<string>,
): { name: string; arguments: string } | null {
  if (!value) return null;
  const parsed = parseStructuredJsonValueDetailed(value);
  if (!parsed) return null;
  return normalizeRecoveredToolCalls(parsed.value, allowedToolNames)[0] ?? null;
}

function mergeRecoveredToolArguments(
  existingRawArguments: string,
  recoveredRawArguments: string,
): string {
  const existingArguments = parseStructuredJsonObject<Record<string, unknown>>(existingRawArguments);
  if (!existingArguments || Object.keys(existingArguments).length === 0 || isToolCallWrapperRecord(existingArguments)) {
    return recoveredRawArguments;
  }
  const recoveredArguments = parseStructuredJsonObject<Record<string, unknown>>(recoveredRawArguments) ?? {};
  return JSON.stringify({
    ...recoveredArguments,
    ...existingArguments,
  });
}

function collectRecoveredToolCallEntries(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }
  if (!isRecord(value)) return [];

  const toolCallsValue = value.toolCalls ?? value.tool_calls;
  if (Array.isArray(toolCallsValue)) {
    return toolCallsValue.filter(isRecord);
  }

  if (isRecord(value.function) && typeof value.function.name === 'string') {
    return [value];
  }

  if (
    typeof value.name === 'string'
    || typeof value.tool === 'string'
    || typeof value.toolName === 'string'
  ) {
    return [value];
  }

  return [];
}

function serializeRecoveredToolArguments(rawArguments: unknown): string {
  if (typeof rawArguments === 'string') {
    const parsed = parseStructuredJsonValueDetailed(rawArguments);
    if (parsed) {
      return JSON.stringify(parsed.value);
    }
    return JSON.stringify({ value: rawArguments });
  }
  return JSON.stringify(rawArguments ?? {});
}

function firstNonEmptyString(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === 'string' && value.trim())?.trim();
}

function isToolCallWrapperRecord(value: Record<string, unknown>): boolean {
  const toolCallsValue = value.toolCalls ?? value.tool_calls;
  if (Array.isArray(toolCallsValue)) {
    return true;
  }
  if (isRecord(value.function) && typeof value.function.name === 'string') {
    return true;
  }
  const hasToolName = typeof value.name === 'string'
    || typeof value.tool === 'string'
    || typeof value.toolName === 'string';
  return hasToolName && ('arguments' in value || 'args' in value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
