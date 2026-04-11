import type { MessageRouter } from './message-router.js';

export type ReservedAgentAlias = 'default' | 'local' | 'external' | 'general';

export interface ConfiguredAgentResolverOptions {
  defaultAgentId: string;
  router: Pick<MessageRouter, 'findAgentByRole'>;
  hasAgent?: (agentId: string) => boolean;
}

export function isReservedAgentAlias(value: string | undefined): value is ReservedAgentAlias {
  return value === 'default' || value === 'local' || value === 'external' || value === 'general';
}

export function normalizeCodeSessionAgentId(
  agentId: string | null | undefined,
  options: Pick<ConfiguredAgentResolverOptions, 'router'>,
): string | null {
  const trimmed = typeof agentId === 'string' && agentId.trim() ? agentId.trim() : '';
  if (!trimmed) return null;
  if (isReservedAgentAlias(trimmed)) return null;
  const localAgentId = options.router.findAgentByRole('local')?.id?.trim();
  const externalAgentId = options.router.findAgentByRole('external')?.id?.trim();
  if (trimmed === localAgentId || trimmed === externalAgentId) {
    return null;
  }
  return trimmed;
}

export function resolveConfiguredAgentId(
  agentId: string | undefined,
  options: ConfiguredAgentResolverOptions,
): string | undefined {
  const trimmed = typeof agentId === 'string' && agentId.trim() ? agentId.trim() : undefined;
  if (!trimmed) return undefined;

  if (trimmed === 'default') {
    const defaultAgentId = options.defaultAgentId.trim();
    return defaultAgentId || undefined;
  }

  if (trimmed === 'local' || trimmed === 'external' || trimmed === 'general') {
    const routedAgentId = options.router.findAgentByRole(trimmed)?.id?.trim();
    if (routedAgentId) return routedAgentId;
    if (options.hasAgent?.(trimmed)) return trimmed;
    return undefined;
  }

  return trimmed;
}
