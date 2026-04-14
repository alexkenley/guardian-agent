import type { IntentGatewayDecision } from './types.js';

export type IntentCapabilityCandidate =
  | 'personal_assistant'
  | 'provider_read'
  | 'filesystem'
  | 'memory_write'
  | 'memory_read'
  | 'coding_backend'
  | 'scheduled_email_automation'
  | 'automation'
  | 'automation_control'
  | 'automation_output'
  | 'workspace_write'
  | 'workspace_read'
  | 'browser'
  | 'web_search'
  | 'coding_session_control';

export function resolveIntentCapabilityCandidates(
  decision: IntentGatewayDecision,
): IntentCapabilityCandidate[] {
  return dedupeCandidates(preferredCandidatesForDecision(decision));
}

function preferredCandidatesForDecision(
  decision: IntentGatewayDecision,
): IntentCapabilityCandidate[] {
  switch (decision.route) {
    case 'automation_authoring':
      return ['create', 'update', 'schedule'].includes(decision.operation)
        ? ['scheduled_email_automation', 'automation']
        : [];
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
    case 'personal_assistant_task':
      return ['personal_assistant'];
    case 'general_assistant':
      return decision.executionClass === 'provider_crud'
        ? ['provider_read']
        : [];
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
    case 'memory_task':
      return decision.operation === 'save'
        ? ['memory_write']
        : (decision.operation === 'read' || decision.operation === 'search')
          ? ['memory_read']
          : [];
    case 'filesystem_task':
      return ['filesystem'];
    case 'coding_task':
      if (decision.entities.codingBackend && decision.entities.codingBackendRequested === true) {
        return ['coding_backend'];
      }
      if (decision.operation === 'search') {
        return ['filesystem'];
      }
      return decision.operation === 'inspect'
        && decision.turnRelation === 'follow_up'
        && decision.entities.codingRunStatusCheck === true
        ? ['coding_backend']
        : [];
    case 'coding_session_control':
      return ['coding_session_control'];
    case 'security_task':
    case 'unknown':
    default:
      return [];
  }
}

function dedupeCandidates(
  candidates: IntentCapabilityCandidate[],
): IntentCapabilityCandidate[] {
  const seen = new Set<IntentCapabilityCandidate>();
  const ordered: IntentCapabilityCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    ordered.push(candidate);
  }
  return ordered;
}
