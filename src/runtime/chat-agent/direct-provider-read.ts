import type { AgentContext, UserMessage } from '../../agent/types.js';
import { isRecord, toBoolean, toString } from '../../chat-agent-helpers.js';
import type { ToolExecutor } from '../../tools/executor.js';
import type { IntentGatewayDecision } from '../intent-gateway.js';

export async function tryDirectProviderRead(input: {
  agentId: string;
  tools?: Pick<ToolExecutor, 'executeModelTool' | 'isEnabled'> | null;
  message: UserMessage;
  ctx: AgentContext;
  decision?: IntentGatewayDecision | null;
}): Promise<string | { content: string; metadata?: Record<string, unknown> } | null> {
  if (!input.tools?.isEnabled()) return null;
  if (input.decision?.executionClass !== 'provider_crud') return null;
  if (!['read', 'inspect'].includes(input.decision.operation)) return null;

  const toolRequest = {
    origin: 'assistant' as const,
    agentId: input.agentId,
    userId: input.message.userId,
    channel: input.message.channel,
    requestId: input.message.id,
    agentContext: { checkAction: input.ctx.checkAction },
    ...(input.message.metadata?.bypassApprovals ? { bypassApprovals: true } : {}),
  };

  const listResult = await input.tools.executeModelTool(
    'llm_provider_list',
    {},
    toolRequest,
  );
  if (!toBoolean(listResult.success)) {
    const msg = toString(listResult.message) || toString(listResult.error) || 'Provider inventory lookup failed.';
    return `I tried to inspect the configured AI providers, but it failed: ${msg}`;
  }

  const output = isRecord(listResult.output) ? listResult.output : {};
  const providers = Array.isArray(output.providers)
    ? output.providers.filter((provider): provider is Record<string, unknown> => isRecord(provider))
    : [];
  if (providers.length === 0) {
    return 'No AI providers are currently configured.';
  }

  const targetProvider = resolveDirectProviderInventoryTarget(input.message.content, providers);
  if (input.decision.operation === 'inspect' && targetProvider) {
    const providerName = toString(targetProvider.name).trim();
    const modelsResult = await input.tools.executeModelTool(
      'llm_provider_models',
      { provider: providerName },
      toolRequest,
    );
    if (toBoolean(modelsResult.success)) {
      return formatDirectProviderModelsResponse(
        targetProvider,
        isRecord(modelsResult.output) ? modelsResult.output : {},
      );
    }
  }

  return formatDirectProviderInventoryResponse(providers);
}

export function resolveDirectProviderInventoryTarget(
  content: string,
  providers: readonly Record<string, unknown>[],
): Record<string, unknown> | null {
  const normalized = content.trim().toLowerCase();
  if (!normalized) return null;
  const matches = providers
    .filter((provider) => {
      const name = toString(provider.name).trim().toLowerCase();
      return !!name && normalized.includes(name);
    })
    .sort((left, right) => toString(right.name).length - toString(left.name).length);
  return matches[0] ?? null;
}

export function formatDirectProviderInventoryResponse(
  providers: readonly Record<string, unknown>[],
): string {
  const providerLabel = providers.length === 1 ? 'provider' : 'providers';
  const lines = [`Configured AI providers (${providers.length} ${providerLabel}):`];
  for (const provider of providers) {
    const name = toString(provider.name).trim() || '(unnamed)';
    const type = toString(provider.type).trim() || 'unknown';
    const model = toString(provider.model).trim() || 'unknown';
    const tier = toString(provider.tier).trim().replace(/_/g, ' ') || 'unknown';
    const connected = provider.connected === true ? 'connected' : 'not verified';
    const flags: string[] = [];
    if (provider.isDefault === true) flags.push('primary');
    if (provider.isPreferredLocal === true) flags.push('preferred local');
    if (provider.isPreferredManagedCloud === true) flags.push('preferred managed cloud');
    if (provider.isPreferredFrontier === true) flags.push('preferred frontier');
    const extras = flags.length > 0 ? ` · ${flags.join(', ')}` : '';
    lines.push(`- ${name} [${tier} · ${type}] model ${model} · ${connected}${extras}`);
  }
  return lines.join('\n');
}

export function formatDirectProviderModelsResponse(
  provider: Record<string, unknown>,
  output: Record<string, unknown>,
): string {
  const providerName = toString(provider.name).trim() || '(unnamed)';
  const activeModel = toString(output.activeModel).trim() || toString(provider.model).trim() || 'unknown';
  const models = Array.isArray(output.models)
    ? output.models
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean)
    : [];
  if (models.length === 0) {
    return `Configured provider ${providerName} is currently set to model ${activeModel}, but no available model catalog was returned.`;
  }
  return [
    `Available models for ${providerName}:`,
    `- Active model: ${activeModel}`,
    ...models.slice(0, 25).map((model) => `- ${model}`),
    ...(models.length > 25 ? [`- ...and ${models.length - 25} more`] : []),
  ].join('\n');
}
