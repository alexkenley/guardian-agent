import type { RoutingTierMode } from './types.js';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function persistRoutingTierModeInRawConfig(
  rawConfig: Record<string, unknown>,
  tierMode: RoutingTierMode,
): Record<string, unknown> {
  const routing = asRecord(rawConfig.routing) ?? {};
  return {
    ...rawConfig,
    routing: {
      ...routing,
      tierMode,
    },
  };
}
