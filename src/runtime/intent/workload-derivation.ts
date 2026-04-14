import { normalizePersonalItemType } from './entity-resolvers/personal-assistant.js';
import { normalizeUiSurface } from './normalization.js';
import type {
  IntentGatewayExecutionClass,
  IntentGatewayExpectedContextPressure,
  IntentGatewayOperation,
  IntentGatewayPreferredAnswerPath,
  IntentGatewayPreferredTier,
  IntentGatewayRoute,
} from './types.js';

export function deriveWorkloadMetadata(
  route: IntentGatewayRoute,
  operation: IntentGatewayOperation,
  parsed: Record<string, unknown>,
): {
  executionClass: IntentGatewayExecutionClass;
  preferredTier: IntentGatewayPreferredTier;
  requiresRepoGrounding: boolean;
  requiresToolSynthesis: boolean;
  expectedContextPressure: IntentGatewayExpectedContextPressure;
  preferredAnswerPath: IntentGatewayPreferredAnswerPath;
} {
  const personalItemType = normalizePersonalItemType(parsed.personalItemType);
  const uiSurface = normalizeUiSurface(parsed.uiSurface);
  const codingBackendRequested = parsed.codingBackendRequested === true;
  const codingRemoteExecRequested = parsed.codingRemoteExecRequested === true;

  switch (route) {
    case 'complex_planning_task':
      return {
        executionClass: 'tool_orchestration',
        preferredTier: 'external',
        requiresRepoGrounding: false,
        requiresToolSynthesis: true,
        expectedContextPressure: 'high',
        preferredAnswerPath: 'chat_synthesis',
      };
    case 'coding_task':
      if (parsed.codingBackend || codingBackendRequested || codingRemoteExecRequested) {
        return {
          executionClass: 'repo_grounded',
          preferredTier: codingRemoteExecRequested ? 'external' : 'local',
          requiresRepoGrounding: true,
          requiresToolSynthesis: true,
          expectedContextPressure: 'high',
          preferredAnswerPath: 'tool_loop',
        };
      }
      if (operation === 'search' || operation === 'read') {
        return {
          executionClass: 'repo_grounded',
          preferredTier: 'external',
          requiresRepoGrounding: true,
          requiresToolSynthesis: false,
          expectedContextPressure: 'medium',
          preferredAnswerPath: 'direct',
        };
      }
      if (operation === 'inspect') {
        return {
          executionClass: 'repo_grounded',
          preferredTier: 'external',
          requiresRepoGrounding: true,
          requiresToolSynthesis: true,
          expectedContextPressure: 'high',
          preferredAnswerPath: 'chat_synthesis',
        };
      }
      return {
        executionClass: 'repo_grounded',
        preferredTier: 'external',
        requiresRepoGrounding: true,
        requiresToolSynthesis: true,
        expectedContextPressure: 'high',
        preferredAnswerPath: 'tool_loop',
      };
    case 'filesystem_task':
      return {
        executionClass: 'repo_grounded',
        preferredTier: 'local',
        requiresRepoGrounding: true,
        requiresToolSynthesis: operation !== 'search' && operation !== 'read',
        expectedContextPressure: operation === 'search' ? 'low' : 'medium',
        preferredAnswerPath: operation === 'search' || operation === 'read' ? 'direct' : 'tool_loop',
      };
    case 'workspace_task':
    case 'email_task':
      return {
        executionClass: 'provider_crud',
        preferredTier: 'external',
        requiresRepoGrounding: false,
        requiresToolSynthesis: true,
        expectedContextPressure: operation === 'draft' ? 'high' : 'medium',
        preferredAnswerPath: 'tool_loop',
      };
    case 'browser_task':
    case 'search_task':
      return {
        executionClass: 'tool_orchestration',
        preferredTier: 'external',
        requiresRepoGrounding: false,
        requiresToolSynthesis: true,
        expectedContextPressure: 'medium',
        preferredAnswerPath: 'tool_loop',
      };
    case 'security_task':
      return {
        executionClass: 'security_analysis',
        preferredTier: 'external',
        requiresRepoGrounding: false,
        requiresToolSynthesis: true,
        expectedContextPressure: 'high',
        preferredAnswerPath: 'chat_synthesis',
      };
    case 'automation_authoring':
    case 'automation_output_task':
      return {
        executionClass: 'tool_orchestration',
        preferredTier: 'external',
        requiresRepoGrounding: false,
        requiresToolSynthesis: true,
        expectedContextPressure: 'high',
        preferredAnswerPath: 'chat_synthesis',
      };
    case 'automation_control':
      return {
        executionClass: 'tool_orchestration',
        preferredTier: 'local',
        requiresRepoGrounding: false,
        requiresToolSynthesis: true,
        expectedContextPressure: 'medium',
        preferredAnswerPath: 'tool_loop',
      };
    case 'personal_assistant_task':
      return {
        executionClass: 'direct_assistant',
        preferredTier: 'local',
        requiresRepoGrounding: false,
        requiresToolSynthesis: ['create', 'update', 'delete', 'draft', 'send', 'schedule'].includes(operation),
        expectedContextPressure: personalItemType === 'brief' || operation === 'draft'
          ? 'high'
          : operation === 'inspect'
            ? 'low'
            : 'medium',
        preferredAnswerPath: ['read', 'inspect', 'search'].includes(operation) ? 'direct' : 'tool_loop',
      };
    case 'memory_task':
    case 'ui_control':
    case 'coding_session_control':
      return {
        executionClass: 'direct_assistant',
        preferredTier: 'local',
        requiresRepoGrounding: false,
        requiresToolSynthesis: ['create', 'update', 'delete'].includes(operation),
        expectedContextPressure: operation === 'inspect' || operation === 'read' || operation === 'navigate'
          ? 'low'
          : 'medium',
        preferredAnswerPath: ['inspect', 'read', 'navigate', 'search'].includes(operation) ? 'direct' : 'tool_loop',
      };
    case 'general_assistant':
      if (uiSurface === 'config') {
        return {
          executionClass: 'provider_crud',
          preferredTier: 'external',
          requiresRepoGrounding: false,
          requiresToolSynthesis: true,
          expectedContextPressure: 'medium',
          preferredAnswerPath: 'tool_loop',
        };
      }
      return {
        executionClass: 'direct_assistant',
        preferredTier: 'local',
        requiresRepoGrounding: false,
        requiresToolSynthesis: false,
        expectedContextPressure: 'low',
        preferredAnswerPath: 'direct',
      };
    case 'unknown':
    default:
      return {
        executionClass: 'direct_assistant',
        preferredTier: 'local',
        requiresRepoGrounding: false,
        requiresToolSynthesis: false,
        expectedContextPressure: 'low',
        preferredAnswerPath: 'direct',
      };
  }
}
