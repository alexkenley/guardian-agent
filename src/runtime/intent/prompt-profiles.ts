import { scoreAutomationOrchestration, scoreComplexity } from '../complexity-scorer.js';
import { isExplicitComplexPlanningRequest, looksLikeContextDependentPromptSelectionTurn } from './request-patterns.js';
import { collapseIntentGatewayWhitespace } from './text.js';
import type { IntentGatewayInput, IntentGatewayPromptProfile } from './types.js';

export function selectIntentGatewayPromptProfile(input: IntentGatewayInput): IntentGatewayPromptProfile {
  const request = collapseIntentGatewayWhitespace(input.content ?? '');
  if (!request) return 'full';
  if (input.pendingAction) return 'full';
  if ((input.continuity || (input.recentHistory?.length ?? 0) > 0)
    && looksLikeContextDependentPromptSelectionTurn(request)) {
    return 'full';
  }
  if (isExplicitComplexPlanningRequest(request)) return 'full';
  if (/[\n`]/.test(request)) return 'full';
  if (/[,:;]/.test(request)) return 'full';
  if (request.includes('/') || request.includes('\\')) return 'full';
  if (/(?:^|[\s(])(?:\.{1,2}\/|\/[A-Za-z0-9._-]|[A-Za-z0-9._-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|txt|yaml|yml|py|rs|go|java|kt|c|cpp|h|hpp|sh))(?:$|[\s),.])/i.test(request)) {
    return 'full';
  }

  const words = request.split(/\s+/).filter(Boolean);
  if (words.length > 10 || request.length > 80) return 'full';

  const complexity = scoreComplexity(request);
  if (complexity.score >= 0.18) return 'full';
  if (complexity.signals.questionDepth >= 0.45) return 'full';
  if (complexity.signals.abstractionMarkers >= 0.5) return 'full';
  if (complexity.signals.multiStepMarkers >= 0.4) return 'full';
  if (complexity.signals.constraintComplexity >= 0.4) return 'full';

  if (scoreAutomationOrchestration(request) >= 0.55) return 'full';

  return 'compact';
}
