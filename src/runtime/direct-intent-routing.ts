import type { IntentGatewayDecision, IntentGatewayRecord } from './intent-gateway.js';

export type DirectIntentRoutingCandidate =
  | 'filesystem'
  | 'scheduled_email_automation'
  | 'automation'
  | 'automation_control'
  | 'automation_output'
  | 'workspace_write'
  | 'workspace_read'
  | 'browser'
  | 'web_search'
  | 'coding_session_control';

export function resolveDirectIntentRoutingCandidates(
  gateway: IntentGatewayRecord | null | undefined,
  fallbackOrder: DirectIntentRoutingCandidate[],
  available: ReadonlyArray<DirectIntentRoutingCandidate>,
): { candidates: DirectIntentRoutingCandidate[]; gatewayDirected: boolean; gatewayUnavailable: boolean } {
  const availableSet = new Set(available);
  if (!gateway || gateway.available === false) {
    return {
      candidates: fallbackOrder.filter((candidate) => availableSet.has(candidate)),
      gatewayDirected: false,
      gatewayUnavailable: true,
    };
  }

  const ordered = preferredCandidatesForDecision(gateway.decision)
    .filter((candidate) => availableSet.has(candidate));
  return {
    candidates: dedupeCandidates(ordered),
    gatewayDirected: true,
    gatewayUnavailable: false,
  };
}

function preferredCandidatesForDecision(
  decision: IntentGatewayDecision,
): DirectIntentRoutingCandidate[] {
  switch (decision.route) {
    case 'automation_authoring':
      return ['scheduled_email_automation', 'automation'];
    case 'automation_control':
      return ['automation_control'];
    case 'automation_output_task':
      return ['automation_output'];
    case 'ui_control':
      if (decision.entities.uiSurface === 'automations'
        && ['delete', 'toggle', 'run', 'inspect', 'clone', 'update'].includes(decision.operation)) {
        return ['automation_control'];
      }
      return [];
    case 'browser_task':
      return ['browser'];
    case 'workspace_task':
      return decision.operation === 'send' || decision.operation === 'draft'
        ? ['workspace_write', 'workspace_read']
        : ['workspace_read', 'workspace_write'];
    case 'email_task':
      return decision.operation === 'send' || decision.operation === 'draft'
        ? ['workspace_write', 'workspace_read']
        : ['workspace_read', 'workspace_write'];
    case 'search_task':
      return ['web_search'];
    case 'filesystem_task':
      return ['filesystem'];
    case 'coding_session_control':
      return ['coding_session_control'];
    case 'coding_task':
    case 'security_task':
    case 'general_assistant':
    case 'unknown':
    default:
      return [];
  }
}

function dedupeCandidates(
  candidates: DirectIntentRoutingCandidate[],
): DirectIntentRoutingCandidate[] {
  const seen = new Set<DirectIntentRoutingCandidate>();
  const ordered: DirectIntentRoutingCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    ordered.push(candidate);
  }
  return ordered;
}
