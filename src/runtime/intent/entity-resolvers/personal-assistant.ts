import { collapseIntentGatewayWhitespace, normalizeIntentGatewayRepairText } from '../text.js';
import { extractPathHint } from '../../search-intent.js';
import {
  isExplicitAutomationAuthoringRequest,
  isExplicitAutomationControlRequest,
  isExplicitAutomationOutputRequest,
} from './automation.js';
import { isConversationTranscriptReferenceRequest } from '../request-patterns.js';
import type {
  IntentGatewayEntities,
  IntentGatewayOperation,
  IntentGatewayRepairContext,
  IntentGatewayRoute,
} from '../types.js';
import {
  normalizeCalendarWindowDays,
  normalizeOperation,
  normalizeRoute,
} from '../normalization.js';

export function inferRoutineEnabledFilter(
  content: string | undefined,
  route: IntentGatewayRoute,
  operation: IntentGatewayOperation,
  personalItemType: IntentGatewayEntities['personalItemType'] | undefined,
): boolean | undefined {
  if (route !== 'personal_assistant_task' || operation !== 'read' || personalItemType !== 'routine') {
    return undefined;
  }
  const normalized = normalizeIntentGatewayRepairText(content);
  if (!normalized) return undefined;
  if (/\bdisabled routines?\b/.test(normalized) || /\bpaused routines?\b/.test(normalized)) {
    return false;
  }
  if (/\benabled routines?\b/.test(normalized) || /\bactive routines?\b/.test(normalized)) {
    return true;
  }
  return undefined;
}

export function inferSecondBrainPersonalItemType(
  repairContext: IntentGatewayRepairContext | undefined,
  route: IntentGatewayRoute,
  operation: IntentGatewayOperation,
): IntentGatewayEntities['personalItemType'] | undefined {
  if (route !== 'personal_assistant_task') {
    return undefined;
  }
  const routineItemType = inferRoutinePersonalItemType(repairContext, route, operation);
  if (routineItemType) {
    return routineItemType;
  }
  const primaryNormalized = normalizeIntentGatewayRepairText(repairContext?.sourceContent);
  const primaryMatch = inferSecondBrainPersonalItemTypeFromText(primaryNormalized, operation);
  if (primaryMatch) {
    return primaryMatch;
  }
  const contextualNormalized = buildSecondBrainContextRepairText(repairContext);
  return inferSecondBrainPersonalItemTypeFromText(contextualNormalized, operation);
}

export function buildSecondBrainContextRepairText(
  repairContext: IntentGatewayRepairContext | undefined,
): string {
  const contextualText = [
    repairContext?.pendingAction?.originalRequest,
    repairContext?.pendingAction?.prompt,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n');
  return normalizeIntentGatewayRepairText(contextualText);
}

function isExplicitFilesystemResourceRequest(normalized: string): boolean {
  if (!normalized) return false;
  if (extractPathHint(normalized)) {
    return true;
  }
  const hasFilesystemNoun = /\b(?:file|files|folder|folders|directory|directories|path|paths)\b/.test(normalized);
  const hasFilesystemVerb = /\b(?:create|add|make|write|save|store|put|read|open|list|show|find|search|delete|remove|move|rename|touch|mkdir)\b/.test(normalized);
  const hasFileNameWithExtension = /\b(?:called|named)\s+["']?[^"'`\\/\s]+\.[A-Za-z0-9]{1,16}\b/.test(normalized)
    || (hasFilesystemNoun && /\b[^"'`\\/\s]+\.[A-Za-z0-9]{1,16}\b/.test(normalized));
  return (hasFilesystemNoun && hasFilesystemVerb) || hasFileNameWithExtension;
}

export function inferSecondBrainPersonalItemTypeFromText(
  normalized: string,
  operation: IntentGatewayOperation,
): IntentGatewayEntities['personalItemType'] | undefined {
  if (!normalized) return undefined;
  if (isConversationTranscriptReferenceRequest(normalized)) {
    return undefined;
  }
  if (isExplicitFilesystemResourceRequest(normalized)) {
    return undefined;
  }
  if (isExplicitAutomationAuthoringRequest(normalized)
    || isExplicitAutomationControlRequest(normalized)
    || isExplicitAutomationOutputRequest(normalized)) {
    return undefined;
  }
  if (
    /\bin second brain\s*>\s*briefs\b/.test(normalized)
    || (/\b(?:generate|regenerate|prepare)\b/.test(normalized)
      && (/\bbrief\b/.test(normalized) || /\bnext meeting\b/.test(normalized)))
  ) {
    return 'brief';
  }
  if (
    /\boverview of my second brain\b/.test(normalized)
    || /\bsecond brain overview\b/.test(normalized)
    || /\bgive me an overview of my second brain\b/.test(normalized)
  ) {
    return 'overview';
  }
  if (/\b(?:calendar|event|events|meeting|meetings|appointment|appointments)\b/.test(normalized)) {
    return 'calendar';
  }
  if (/\b(?:library|link|links|url)\b/.test(normalized)) {
    return 'library';
  }
  if (
    /\b(?:person|people|contact|contacts)\b/.test(normalized)
    || (/\bemail\b/.test(normalized) && /\b(?:company|title|notes?)\b/.test(normalized))
  ) {
    return 'person';
  }
  if (/\btask\b/.test(normalized) || (operation !== 'read' && /\bdue\b/.test(normalized))) {
    return 'task';
  }
  if (/\bnotes?\b/.test(normalized)) {
    return 'note';
  }
  if (/\bbrief\b/.test(normalized)) {
    return 'brief';
  }
  if (/\boverview\b/.test(normalized)) {
    return 'overview';
  }
  return undefined;
}

export function inferRoutinePersonalItemType(
  repairContext: IntentGatewayRepairContext | undefined,
  route: IntentGatewayRoute,
  operation: IntentGatewayOperation,
): IntentGatewayEntities['personalItemType'] | undefined {
  if (route !== 'personal_assistant_task') {
    return undefined;
  }
  const normalized = normalizeIntentGatewayRepairText(repairContext?.sourceContent);
  if (!normalized) return undefined;
  if (isExplicitAutomationAuthoringRequest(normalized)
    || isExplicitAutomationControlRequest(normalized)
    || isExplicitAutomationOutputRequest(normalized)) {
    return undefined;
  }
  if (isExplicitSecondBrainRoutineRequest(normalized, operation)
    || pendingActionSuggestsRoutine(repairContext)) {
    return 'routine';
  }
  return undefined;
}

export function inferSecondBrainQuery(
  content: string | undefined,
  route: IntentGatewayRoute,
  operation: IntentGatewayOperation,
  personalItemType: IntentGatewayEntities['personalItemType'] | undefined,
): string | undefined {
  if (route !== 'personal_assistant_task' || !['inspect', 'read', 'search'].includes(operation)) {
    return undefined;
  }
  if (personalItemType === 'routine') {
    return inferRoutineQuery(content);
  }
  if (personalItemType === 'library') {
    return inferLibraryReadQuery(content);
  }
  if (personalItemType === 'person') {
    return inferPersonReadQuery(content);
  }
  return undefined;
}

export function inferRoutineQuery(content: string | undefined): string | undefined {
  const normalized = collapseIntentGatewayWhitespace(content ?? '');
  if (!normalized) return undefined;
  const relatedMatch = normalized.match(/\brelated\s+to\s+(.+?)(?:[.?!]|$)/i);
  return relatedMatch?.[1]?.trim() || undefined;
}

export function inferLibraryReadQuery(content: string | undefined): string | undefined {
  const collapsed = collapseIntentGatewayWhitespace(content ?? '');
  if (!collapsed) return undefined;
  const aboutMatch = collapsed.match(/\babout\s+(.+?)(?:[.?!]|$)/i);
  if (aboutMatch?.[1]?.trim()) {
    return aboutMatch[1].trim();
  }
  const relatedMatch = collapsed.match(/\brelated\s+to\s+(.+?)(?:[.?!]|$)/i);
  if (relatedMatch?.[1]?.trim()) {
    return relatedMatch[1].trim();
  }
  const quotedMatch = collapsed.match(/["']([^"']+)["']/);
  return quotedMatch?.[1]?.trim() || undefined;
}

export function inferPersonReadQuery(content: string | undefined): string | undefined {
  const collapsed = collapseIntentGatewayWhitespace(content ?? '');
  if (!collapsed) return undefined;
  const quotedMatch = collapsed.match(/["']([^"']+)["']/);
  if (quotedMatch?.[1]?.trim()) {
    return quotedMatch[1].trim();
  }
  const namedMatch = collapsed.match(/\b(?:person|contact)\b(?:\s+named)?\s+([A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){1,3})(?=\s*(?:in my second brain|$|[.?!]))/);
  if (namedMatch?.[1]?.trim()) {
    return namedMatch[1].trim();
  }
  return undefined;
}

export function inferSecondBrainOperation(
  content: string | undefined,
  route: IntentGatewayRoute,
  operation: IntentGatewayOperation,
): IntentGatewayOperation | undefined {
  if (route !== 'personal_assistant_task') {
    return undefined;
  }
  if (operation !== 'unknown' && operation !== 'navigate') {
    return undefined;
  }
  const normalized = normalizeIntentGatewayRepairText(content);
  if (!normalized) return undefined;
  if (/\b(?:delete|remove|erase)\b/.test(normalized)) {
    return 'delete';
  }
  if (/\b(?:update|edit|change|rename|move|mark)\b/.test(normalized)) {
    return 'update';
  }
  if (/\bsave\b/.test(normalized)) {
    return 'save';
  }
  if (/\b(?:create|add)\b/.test(normalized)) {
    return 'create';
  }
  if (/\b(?:find|search|look up|lookup|look through)\b/.test(normalized)) {
    return 'search';
  }
  if (/\b(?:show|list|what|which|view)\b/.test(normalized)) {
    return 'read';
  }
  if (/\b(?:overview|summarize|summary|due today|today)\b/.test(normalized)) {
    return 'inspect';
  }
  return undefined;
}

export function normalizePersonalItemType(
  value: unknown,
): IntentGatewayEntities['personalItemType'] | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  switch (normalized) {
    case 'overview':
    case 'note':
    case 'task':
    case 'calendar':
    case 'person':
    case 'library':
    case 'routine':
    case 'brief':
      return normalized;
    case 'today':
    case 'dashboard':
      return 'overview';
    default:
      return normalized === 'unknown' ? 'unknown' : undefined;
  }
}

export function containsSecondBrainRoutineConcept(content: string): boolean {
  return /\b(?:show|list|view|read|inspect)\s+(?:my\s+)?routines?\b/.test(content)
    || /\b(?:my|enabled|disabled|paused|active)\s+routines?\b/.test(content)
    || /\bwhat\s+routines?\b/.test(content)
    || /\broutines?\s+tab\b/.test(content)
    || /\bsecond brain\s+routines?\b/.test(content)
    || /\broutines?\b.*\bin second brain\b/.test(content)
    || /\bin second brain\b.*\broutines?\b/.test(content)
    || /\bmorning brief\b/.test(content)
    || /\bpre[- ]meeting brief\b/.test(content)
    || /\bfollow[- ]up (?:watch|draft)\b/.test(content)
    || /\bweekly review\b/.test(content)
    || /\bscheduled review\b/.test(content)
    || /\btopic watch\b/.test(content)
    || /\bdeadline watch\b/.test(content)
    || /\bdaily agenda check\b/.test(content)
    || /\bnext 24 hours radar\b/.test(content)
    || /\bmanual sync\b/.test(content);
}

export function hasRoutineSchedulePhrase(content: string): boolean {
  return /\b(?:every|each|hourly|daily|weekdays|weekly|fortnightly|monthly|biweekly|bi-weekly|every 2 weeks)\b/.test(content)
    || /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(content);
}

export function isExplicitSecondBrainRoutineRequest(
  content: string | undefined,
  operation: IntentGatewayOperation,
): boolean {
  const normalized = normalizeIntentGatewayRepairText(content);
  if (!normalized) return false;
  if (isConversationTranscriptReferenceRequest(normalized)) {
    return false;
  }
  if (containsSecondBrainRoutineConcept(normalized)) {
    return true;
  }
  if (/\bmessage me when\b/.test(normalized) && /\b(?:mention|mentions|mentioned|due|overdue)\b/.test(normalized)) {
    return true;
  }
  if ((operation === 'create' || operation === 'update' || operation === 'toggle' || operation === 'delete')
    && /\b(?:that|this|my)\s+routine\b/.test(normalized)) {
    return true;
  }
  if (operation === 'create' && /\bcreate\b/.test(normalized) && /\broutine\b/.test(normalized)) {
    return true;
  }
  if (operation === 'create' && /\breview\b/.test(normalized) && hasRoutineSchedulePhrase(normalized)) {
    return true;
  }
  return false;
}

export function isExplicitSecondBrainEntityRequest(
  content: string | undefined,
  operation: IntentGatewayOperation,
): boolean {
  const normalized = normalizeIntentGatewayRepairText(content);
  if (!normalized) return false;
  if (isConversationTranscriptReferenceRequest(normalized)) {
    return false;
  }
  if (isExplicitFilesystemResourceRequest(normalized)) {
    return false;
  }
  const personalItemType = inferSecondBrainPersonalItemTypeFromText(normalized, operation);
  if (!personalItemType || personalItemType === 'routine') {
    return false;
  }
  if (/\b(?:google calendar|outlook calendar|microsoft 365 calendar|gmail|outlook|google workspace|microsoft 365|office 365|google docs?|google sheets?|google drive|onedrive|sharepoint|teams)\b/.test(normalized)) {
    return false;
  }
  if (['create', 'update', 'delete', 'save'].includes(operation)) {
    return true;
  }
  return /\b(?:second brain|my tasks?|my notes?|my library|my briefs?|my calendar|my events?|my people|my contacts?|people in my second brain|contacts? in my second brain)\b/.test(normalized);
}

export function pendingActionSuggestsRoutine(
  repairContext: IntentGatewayRepairContext | undefined,
): boolean {
  const pendingAction = repairContext?.pendingAction;
  if (!pendingAction) return false;
  return isExplicitSecondBrainRoutineRequest(
    `${pendingAction.prompt ?? ''}\n${pendingAction.originalRequest ?? ''}`,
    normalizeOperation(pendingAction.operation),
  );
}

export function pendingActionSuggestsPersonalAssistantTask(
  repairContext: IntentGatewayRepairContext | undefined,
): boolean {
  const pendingAction = repairContext?.pendingAction;
  if (!pendingAction) return false;
  return normalizeRoute(pendingAction.route) === 'personal_assistant_task';
}

export function inferCalendarWindowDays(
  content: string | undefined,
  route: IntentGatewayRoute,
  personalItemType: IntentGatewayEntities['personalItemType'] | undefined,
): number | undefined {
  if (route !== 'personal_assistant_task' || personalItemType !== 'calendar') {
    return undefined;
  }
  const normalized = normalizeIntentGatewayRepairText(content);
  if (!normalized) return undefined;

  const digitMatch = normalized.match(/\bnext\s+(\d{1,3})\s+days?\b/);
  if (digitMatch) {
    return normalizeCalendarWindowDays(Number(digitMatch[1]));
  }

  const wordMap: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
  };
  const wordMatch = normalized.match(/\bnext\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen)\s+days?\b/);
  if (wordMatch) {
    return wordMap[wordMatch[1]] ?? undefined;
  }
  if (/\btoday\b/.test(normalized)) {
    return 1;
  }
  if (/\bthis week\b/.test(normalized)) {
    return 7;
  }
  return undefined;
}
