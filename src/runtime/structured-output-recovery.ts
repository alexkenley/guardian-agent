import type { ChatMessage, ChatOptions, ChatResponse } from '../llm/types.js';
import {
  parseStructuredJsonObjectDetailed,
  type StructuredJsonParseResult,
} from '../util/structured-json.js';

export interface StructuredObjectRecoveryResult<T extends Record<string, unknown>> {
  value: T;
  source: 'direct_parse' | 'repair_prompt';
  repaired: boolean;
  confidence: 'high' | 'medium' | 'low';
  flags: string[];
}

export async function recoverStructuredObjectWithRepair<T extends Record<string, unknown>>(options: {
  response: ChatResponse;
  repairChat?: (messages: ChatMessage[], options?: ChatOptions) => Promise<ChatResponse>;
  repairMessages?: ChatMessage[];
  repairSchemaDescription: string;
  repairMaxTokens?: number;
}): Promise<StructuredObjectRecoveryResult<T> | null> {
  const direct = parseStructuredJsonObjectDetailed<T>(options.response.content);
  if (direct) {
    return toRecoveryResult(direct, 'direct_parse');
  }

  if (!options.repairChat || !options.repairMessages?.length) {
    return null;
  }

  const repairedResponse = await options.repairChat(
    [
      ...options.repairMessages,
      {
        role: 'assistant',
        content: options.response.content,
      },
      {
        role: 'user',
        content: [
          'Your previous reply was not valid JSON.',
          `Restate the same answer as strict JSON only using this schema: ${options.repairSchemaDescription}.`,
          'Do not add prose, markdown, or extra keys.',
        ].join(' '),
      },
    ],
    {
      maxTokens: options.repairMaxTokens ?? 220,
      temperature: 0,
      responseFormat: { type: 'json_object' },
      tools: [],
    },
  );

  const repaired = parseStructuredJsonObjectDetailed<T>(repairedResponse.content);
  if (!repaired) return null;
  return toRecoveryResult(repaired, 'repair_prompt');
}

function toRecoveryResult<T extends Record<string, unknown>>(
  parsed: StructuredJsonParseResult<T>,
  source: StructuredObjectRecoveryResult<T>['source'],
): StructuredObjectRecoveryResult<T> {
  return {
    value: parsed.value,
    source,
    repaired: parsed.repaired || source === 'repair_prompt',
    confidence: parsed.confidence,
    flags: [...parsed.flags],
  };
}
