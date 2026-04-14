import type { IntentGatewayRecord } from './intent-gateway.js';
import {
  resolveIntentCapabilityCandidates,
  type IntentCapabilityCandidate,
} from './intent/capability-resolver.js';

export type DirectIntentRoutingCandidate = IntentCapabilityCandidate;

export function resolveDirectIntentRoutingCandidates(
  gateway: IntentGatewayRecord | null | undefined,
  available: ReadonlyArray<DirectIntentRoutingCandidate>,
): {
  candidates: DirectIntentRoutingCandidate[];
  gatewayDirected: boolean;
  gatewayUnavailable: boolean;
} {
  const availableSet = new Set(available);
  if (!gateway || gateway.available === false) {
    return {
      candidates: [],
      gatewayDirected: false,
      gatewayUnavailable: true,
    };
  }

  if (gateway.decision.confidence === 'low'
    && (gateway.decision.route === 'unknown' || gateway.decision.route === 'general_assistant')) {
    return {
      candidates: [],
      gatewayDirected: false,
      gatewayUnavailable: false,
    };
  }

  const ordered = resolveIntentCapabilityCandidates(gateway.decision)
    .filter((candidate) => availableSet.has(candidate));
  return {
    candidates: ordered,
    gatewayDirected: true,
    gatewayUnavailable: false,
  };
}

export function shouldAllowBoundedDegradedMemorySaveFallback(
  gateway: IntentGatewayRecord | null | undefined,
): boolean {
  if (!gateway) return true;
  return gateway.available === false && gateway.decision.route === 'unknown';
}
