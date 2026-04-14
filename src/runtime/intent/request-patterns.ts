import { normalizeIntentGatewayRepairText } from './text.js';

export function looksLikeContextDependentPromptSelectionTurn(request: string): boolean {
  const normalized = request.trim().toLowerCase();
  if (!normalized || normalized.length > 64) return false;
  return /^(?:yes|yeah|yep|no|nope|ok|okay|sure|actually|instead|use\b|switch\b|continue\b|resume\b|retry\b|again\b|same\b|that\b|those\b|it\b|them\b|this\b)/.test(normalized)
    || /\b(?:that|those|it|them|same\s+(?:one|workspace|session)|again)\b/.test(normalized);
}

export function isExplicitComplexPlanningRequest(content: string | undefined): boolean {
  const normalized = normalizeIntentGatewayRepairText(content);
  if (!normalized) return false;
  return /\buse (?:your|the) complex[- ]planning path\b/.test(normalized)
    || /\b(?:route|send) (?:this|it|the request)?\s*(?:through|to) (?:your |the )?complex[- ]planning path\b/.test(normalized)
    || /\b(?:use|run|route|handle|take)\b[^.!?\n]{0,80}\b(?:dag planner|dag path|planner path)\b/.test(normalized);
}
