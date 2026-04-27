import type { IntentGatewayOperation, IntentGatewayRoute } from '../types.js';
import { collapseIntentGatewayWhitespace } from '../text.js';

const AUTOMATION_AUTHORING_VERB_PATTERN = /\b(?:create|build|set up|setup|make|configure|schedule|automate|turn into|save)\b/i;
const AUTOMATION_AUTHORING_NOUN_PATTERN = /\b(?:automation|automations|workflow|workflows|playbook|playbooks|pipeline|pipelines|scheduled automation|scheduled automations|scheduled task|scheduled tasks|assistant automation|assistant automations|assistant task|assistant tasks)\b/i;
const AUTOMATION_AUTHORING_WORKFLOW_HINT_PATTERN = /\b(?:deterministic scheduled automation|deterministic workflow|step[- ]based workflow|fixed tool steps|do not create an assistant automation|don't create an assistant automation|do not create a scheduled assistant task|don't create a scheduled assistant task)\b/i;
const AUTOMATION_CONTROL_VERB_PATTERN = /\b(?:disable|enable|run|inspect|show|read|delete|remove|rename|edit|update|change|modify|clone|list)\b/i;
const AUTOMATION_COUNT_VIEW_PATTERN = /\b(?:how many|number of|count(?:ed|ing)?|total)\b/i;
const AUTOMATION_OUTPUT_ANALYSIS_PATTERN = /\b(analy[sz]e|summari[sz]e|explain|review|compare|investigate|interpret|what did(?:\s+it)?\s+find)\b/i;
const AUTOMATION_OUTPUT_CONTEXT_PATTERN = /\b(output|outputs|result|results|findings|history|timeline|step output|run output)\b/i;
const INJECTED_SKILL_CATALOG_PATTERN = /\brelevant skills(?: when useful)?:[\s\S]*$/i;
const FILE_REFERENCE_PATTERN = /\b(?:[a-z]:\\[^\s"'`]+|(?:src|docs|tmp|web|policies|scripts|native|skills)\/[^\s"'`]+|[a-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|txt|csv|log|toml|ini|py|rs|go|java|rb|php|sh|ya?ml))\b/gi;

export function isExplicitAutomationAuthoringRequest(content: string | undefined): boolean {
  const normalized = normalizeAutomationIntentSource(content);
  if (!normalized) return false;
  if (isExplicitAutomationOutputRequest(normalized)) return false;
  if (isExplicitAutomationControlRequest(normalized)) return false;
  if (AUTOMATION_AUTHORING_WORKFLOW_HINT_PATTERN.test(normalized) && AUTOMATION_AUTHORING_NOUN_PATTERN.test(normalized)) {
    return true;
  }
  if (!AUTOMATION_AUTHORING_NOUN_PATTERN.test(normalized)) return false;
  return AUTOMATION_AUTHORING_VERB_PATTERN.test(normalized);
}

export function isExplicitAutomationControlRequest(content: string | undefined): boolean {
  const normalized = normalizeAutomationIntentSource(content);
  if (!normalized) return false;
  if (isExplicitAutomationOutputRequest(normalized)) return false;
  const inferredOperation = inferAutomationControlOperation(normalized);
  const mentionsAutomation = /\bautomation\b/i.test(normalized) || /\bautomations\b/i.test(normalized);
  if (mentionsAutomation && isReadOnlyAutomationControlOperation(inferredOperation)) {
    return true;
  }
  if (/\b(?:what|which|kind|kinds|sort|sorts|examples?|capabilities?|support|supported|how)\b/i.test(normalized)) {
    return false;
  }
  if (/\bcreate\b/i.test(normalized)) return false;
  if (!AUTOMATION_CONTROL_VERB_PATTERN.test(normalized)) return false;
  return mentionsAutomation;
}

export function isExplicitAutomationOutputRequest(content: string | undefined): boolean {
  const normalized = normalizeAutomationIntentSource(content);
  if (!normalized) return false;
  if (!/\b(automation|automations|workflow|workflows|assistant automation|scheduled task|task|run)\b/i.test(normalized)) {
    return false;
  }
  if (!AUTOMATION_OUTPUT_ANALYSIS_PATTERN.test(normalized)) return false;
  if (!AUTOMATION_OUTPUT_CONTEXT_PATTERN.test(normalized)) return false;
  return true;
}

export function inferAutomationControlOperation(
  content: string | undefined,
  fallback: IntentGatewayOperation = 'unknown',
): IntentGatewayOperation {
  if (fallback === 'delete' || fallback === 'toggle' || fallback === 'run' || fallback === 'inspect'
    || fallback === 'read' || fallback === 'clone' || fallback === 'update') {
    return fallback;
  }
  const normalized = normalizeAutomationIntentSource(content).toLowerCase();
  if (!normalized) return 'unknown';
  const inferred = inferFirstAutomationControlOperation(normalized);
  if (inferred) return inferred;
  return 'unknown';
}

export function inferAutomationReadView(
  content: string | undefined,
  route: IntentGatewayRoute,
  operation: IntentGatewayOperation,
): 'catalog' | 'count' | undefined {
  if (route !== 'automation_control') return undefined;
  if (operation !== 'read' && operation !== 'inspect' && operation !== 'search') return undefined;
  const normalized = normalizeAutomationIntentSource(content);
  if (!normalized) return undefined;
  if (!/\bautomations?\b/i.test(normalized)) return undefined;
  if (AUTOMATION_COUNT_VIEW_PATTERN.test(normalized)) return 'count';
  return undefined;
}

function isReadOnlyAutomationControlOperation(operation: IntentGatewayOperation): boolean {
  return operation === 'read' || operation === 'inspect' || operation === 'search';
}

function inferFirstAutomationControlOperation(content: string): IntentGatewayOperation | undefined {
  const candidates: Array<{ operation: IntentGatewayOperation; index: number; order: number }> = [];
  ([
    ['toggle', /\b(?:disable|enable)\b/],
    ['run', /\brun\b/],
    ['read', /\b(?:inspect|show|read|list)\b/],
    ['delete', /\b(?:delete|remove)\b/],
    ['update', /\b(?:rename|edit|update|change|modify)\b/],
    ['clone', /\bclone\b/],
  ] as const).forEach(([operation, pattern], order) => {
    const match = pattern.exec(content);
    if (typeof match?.index === 'number') {
      candidates.push({ operation, index: match.index, order });
    }
  });
  candidates.sort((left, right) => left.index - right.index || left.order - right.order);
  return candidates[0]?.operation;
}

export function inferAutomationEnabledState(content: string | undefined): boolean | undefined {
  const normalized = normalizeAutomationIntentSource(content).toLowerCase();
  if (!normalized) return undefined;
  if (/\bdisable\b/.test(normalized)) return false;
  if (/\benable\b/.test(normalized)) return true;
  return undefined;
}

export function inferAutomationOutputOperation(
  content: string | undefined,
  fallback: IntentGatewayOperation = 'unknown',
): IntentGatewayOperation {
  if (fallback === 'inspect' || fallback === 'read' || fallback === 'search') {
    return fallback;
  }
  const normalized = normalizeAutomationIntentSource(content).toLowerCase();
  if (!normalized) return 'unknown';
  if (/\bsearch\b/.test(normalized)) return 'search';
  if (/\bread\b/.test(normalized)) return 'read';
  if (AUTOMATION_OUTPUT_ANALYSIS_PATTERN.test(normalized)) return 'inspect';
  return 'unknown';
}

export function extractExplicitAutomationName(content: string | undefined): string | undefined {
  const raw = content ?? '';
  if (!raw.trim()) return undefined;
  const patterns = [
    /\bautomation\s+(?:called|named)\s+(.+?)(?:[.?!]|$)/i,
    /\b(?:disable|enable|inspect|show|read|delete|remove|edit|update|change|modify|clone|run)\s+(?:the\s+)?automation\s+(.+?)(?:[.?!]|$)/i,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    const candidate = cleanAutomationNameCandidate(match?.[1]);
    if (candidate) return candidate;
  }
  return undefined;
}

export function extractExplicitAutomationOutputName(content: string | undefined): string | undefined {
  const raw = content ?? '';
  if (!raw.trim()) return undefined;
  const patterns = [
    /\b(?:from|of)\s+the\s+(?:last|latest|most recent)\s+(.+?)\s+automation\s+run\b/i,
    /\b(?:from|of)\s+(.+?)\s+automation\s+run\b/i,
    /\b(.+?)\s+automation\s+run\b/i,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    const candidate = cleanAutomationNameCandidate(match?.[1]);
    if (candidate) return candidate;
  }
  return undefined;
}

function cleanAutomationNameCandidate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = collapseIntentGatewayWhitespace(value)
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[.?!]+$/g, '')
    .replace(/\b(?:for me|please|now)\b$/i, '')
    .trim();
  return cleaned || undefined;
}

function normalizeAutomationIntentSource(content: string | undefined): string {
  return collapseIntentGatewayWhitespace(
    (content ?? '')
      .replace(INJECTED_SKILL_CATALOG_PATTERN, ' ')
      .replace(FILE_REFERENCE_PATTERN, ' '),
  );
}
