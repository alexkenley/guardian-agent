import type { AgentContext } from '../../agent/types.js';
import type { ChatMessage, ChatOptions, ChatResponse } from '../../llm/types.js';
import type { ModelFallbackChain } from '../../llm/model-fallback.js';
import {
  buildLocalModelTooComplicatedMessage,
  getProviderLocalityFromName,
  isLocalToolCallParseError,
  shouldBypassLocalModelComplexityGuard,
} from '../model-routing-ux.js';

export interface ProviderFallbackLogger {
  warn: (metadata: Record<string, unknown>, message: string) => void;
}

export type ChatAgentFallbackChain = Pick<
  ModelFallbackChain,
  | 'chatWithFallback'
  | 'chatWithFallbackAfterPrimary'
  | 'chatWithFallbackAfterProvider'
  | 'chatWithProviderOrder'
>;

export interface ChatWithFallbackInput {
  agentId: string;
  ctx: AgentContext;
  messages: ChatMessage[];
  options?: ChatOptions;
  fallbackProviderOrder?: string[];
  fallbackChain?: ChatAgentFallbackChain;
  log: ProviderFallbackLogger;
}

export interface ChatWithRoutingMetadataResult {
  response: ChatResponse;
  providerName: string;
  providerLocality: 'local' | 'external';
  usedFallback: boolean;
  notice?: string;
  durationMs: number;
}

export function resolvePreferredProviderOrder(
  fallbackProviderOrder?: string[],
): string[] | undefined {
  if (!Array.isArray(fallbackProviderOrder) || fallbackProviderOrder.length <= 0) {
    return undefined;
  }
  const normalized = [...new Set(
    fallbackProviderOrder
      .map((providerName) => providerName.trim())
      .filter((providerName) => providerName.length > 0),
  )];
  return normalized.length > 0 ? normalized : undefined;
}

export function shouldStartChatWithPreferredProvider(input: {
  fallbackChain?: ChatAgentFallbackChain;
  primaryProviderName?: string;
  preferredProviderOrder?: string[];
}): boolean {
  if (!input.fallbackChain || !input.preferredProviderOrder || input.preferredProviderOrder.length <= 0) {
    return false;
  }
  const preferredPrimary = input.preferredProviderOrder[0]?.trim() || '';
  if (!preferredPrimary) return false;
  return preferredPrimary !== (input.primaryProviderName?.trim() || '');
}

export async function chatWithFallback(input: ChatWithFallbackInput): Promise<ChatResponse> {
  const preferredOrder = resolvePreferredProviderOrder(input.fallbackProviderOrder);
  const primaryProviderName = input.ctx.llm?.name?.trim();
  if (shouldStartChatWithPreferredProvider({
    fallbackChain: input.fallbackChain,
    primaryProviderName,
    preferredProviderOrder: preferredOrder,
  })) {
    return (await input.fallbackChain!.chatWithProviderOrder(preferredOrder!, input.messages, input.options)).response;
  }
  if (!input.fallbackChain) {
    return input.ctx.llm!.chat(input.messages, input.options);
  }
  try {
    return await input.ctx.llm!.chat(input.messages, input.options);
  } catch (primaryError) {
    input.log.warn(
      { agent: input.agentId, error: primaryError instanceof Error ? primaryError.message : String(primaryError) },
      'Primary LLM failed, trying fallback chain',
    );
    const result = preferredOrder
      ? await input.fallbackChain.chatWithFallbackAfterProvider(input.ctx.llm?.name ?? 'unknown', preferredOrder, input.messages, input.options)
      : await input.fallbackChain.chatWithFallback(input.messages, input.options);
    return result.response;
  }
}

export async function chatWithRoutingMetadata(
  input: ChatWithFallbackInput,
): Promise<ChatWithRoutingMetadataResult> {
  const primaryProviderName = input.ctx.llm?.name ?? 'unknown';
  const primaryProviderLocality = getProviderLocalityFromName(primaryProviderName);
  const preferredOrder = resolvePreferredProviderOrder(input.fallbackProviderOrder);

  if (shouldStartChatWithPreferredProvider({
    fallbackChain: input.fallbackChain,
    primaryProviderName,
    preferredProviderOrder: preferredOrder,
  })) {
    const startedAt = Date.now();
    const result = await input.fallbackChain!.chatWithProviderOrder(preferredOrder!, input.messages, input.options);
    return {
      response: result.response,
      providerName: result.providerName,
      providerLocality: getProviderLocalityFromName(result.providerName),
      usedFallback: result.usedFallback,
      durationMs: Math.max(0, Date.now() - startedAt),
    };
  }

  if (!input.fallbackChain) {
    try {
      const startedAt = Date.now();
      const response = await input.ctx.llm!.chat(input.messages, input.options);
      return {
        response,
        providerName: primaryProviderName,
        providerLocality: primaryProviderLocality,
        usedFallback: false,
        durationMs: Math.max(0, Date.now() - startedAt),
      };
    } catch (primaryError) {
      if (primaryProviderLocality === 'local' && isLocalToolCallParseError(primaryError)) {
        if (shouldBypassLocalModelComplexityGuard()) {
          throw primaryError;
        }
        throw new Error(buildLocalModelTooComplicatedMessage());
      }
      throw primaryError;
    }
  }

  try {
    const startedAt = Date.now();
    const response = await input.ctx.llm!.chat(input.messages, input.options);
    return {
      response,
      providerName: primaryProviderName,
      providerLocality: primaryProviderLocality,
      usedFallback: false,
      durationMs: Math.max(0, Date.now() - startedAt),
    };
  } catch (primaryError) {
    input.log.warn(
      { agent: input.agentId, error: primaryError instanceof Error ? primaryError.message : String(primaryError) },
      'Primary LLM failed, trying fallback chain',
    );

    if (primaryProviderLocality === 'local' && isLocalToolCallParseError(primaryError)) {
      if (shouldBypassLocalModelComplexityGuard()) {
        throw primaryError;
      }
      try {
        const startedAt = Date.now();
        const result = preferredOrder
          ? await input.fallbackChain.chatWithFallbackAfterProvider(primaryProviderName, preferredOrder, input.messages, input.options)
          : await input.fallbackChain.chatWithFallbackAfterPrimary(input.messages, input.options);
        return {
          response: result.response,
          providerName: result.providerName,
          providerLocality: getProviderLocalityFromName(result.providerName),
          usedFallback: true,
          notice: 'Retried with an alternate model after the local model failed to format a tool call.',
          durationMs: Math.max(0, Date.now() - startedAt),
        };
      } catch (fallbackError) {
        input.log.warn(
          { agent: input.agentId, error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError) },
          'No alternate model available after local tool-call parsing failure',
        );
        throw new Error(buildLocalModelTooComplicatedMessage());
      }
    }

    const startedAt = Date.now();
    const result = preferredOrder
      ? await input.fallbackChain.chatWithFallbackAfterProvider(primaryProviderName, preferredOrder, input.messages, input.options)
      : await input.fallbackChain.chatWithFallback(input.messages, input.options);
    return {
      response: result.response,
      providerName: result.providerName,
      providerLocality: getProviderLocalityFromName(result.providerName),
      usedFallback: result.usedFallback || result.providerName !== primaryProviderName,
      durationMs: Math.max(0, Date.now() - startedAt),
    };
  }
}
