import type { DirectIntentRoutingCandidate } from '../direct-intent-routing.js';

export type DirectIntentDispatchResult =
  | string
  | { content: string; metadata?: Record<string, unknown> };

export async function dispatchDirectIntentCandidates<TResponse>(input: {
  candidates: readonly DirectIntentRoutingCandidate[];
  handlers: Partial<Record<DirectIntentRoutingCandidate, () => Promise<DirectIntentDispatchResult | null>>>;
  onHandled: (candidate: DirectIntentRoutingCandidate, result: DirectIntentDispatchResult) => Promise<TResponse>;
  gatewayDirected: boolean;
  allowDegradedMemoryFallback: boolean;
  onDegradedMemoryFallback?: () => Promise<TResponse | null>;
}): Promise<TResponse | null> {
  for (const candidate of input.candidates) {
    const handler = input.handlers[candidate];
    if (!handler) {
      continue;
    }
    const result = await handler();
    if (!result) {
      continue;
    }
    return input.onHandled(candidate, result);
  }

  if (!input.gatewayDirected && input.allowDegradedMemoryFallback && input.onDegradedMemoryFallback) {
    return input.onDegradedMemoryFallback();
  }

  return null;
}
