import type { ChatResponse } from '../../llm/types.js';
import { parseStructuredJsonObject } from '../../util/structured-json.js';
import {
  repairStructuredIntentGatewayOperation,
  repairStructuredIntentGatewayRoute,
} from './gateway-semantic-repair.js';
import {
  repairIntentGatewayOperation,
  repairIntentGatewayRoute,
} from './clarification-resolver.js';
import { classifierProvenanceSourceForMode } from './provenance.js';
import { resolveIntentGatewayEntities } from './route-entity-resolution.js';
import { INTENT_GATEWAY_MISSING_SUMMARY } from './summary.js';
import {
  normalizeConfidence,
  normalizeExecutionClass,
  normalizeExpectedContextPressure,
  normalizeOperation,
  normalizePreferredAnswerPath,
  normalizePreferredTier,
  normalizeResolution,
  normalizeRoute,
  normalizeSimpleVsComplex,
  normalizeTurnRelation,
} from './normalization.js';
import { collapseIntentGatewayWhitespace } from './text.js';
import {
  isExplicitRepoInspectionRequest,
  requestNeedsExactFileReferences,
} from './request-patterns.js';
import type {
  IntentGatewayDecision,
  IntentGatewayPlannedStep,
  IntentGatewayProvenanceSource,
  IntentGatewayRepairContext,
  IntentGatewayRecord,
} from './types.js';
import { repairUnavailableIntentGatewayDecision } from './unstructured-recovery.js';
import { deriveWorkloadMetadata } from './workload-derivation.js';

export function parseIntentGatewayDecision(
  response: ChatResponse,
  repairContext?: IntentGatewayRepairContext,
  options?: { mode?: IntentGatewayRecord['mode'] },
): { decision: IntentGatewayDecision; available: boolean; rawStructuredDecision?: Record<string, unknown> } {
  const classifierSource = classifierProvenanceSourceForMode(options?.mode ?? 'primary');
  const unstructuredClarificationPrompt = extractUnstructuredClarificationPrompt(response.content);
  const parsed = parseStructuredToolArguments(response)
    ?? parseStructuredContent(response.content)
    ?? recoverMalformedStructuredContent(response);
  if (!parsed) {
    const repaired = repairUnavailableIntentGatewayDecision(
      repairContext,
      undefined,
      normalizeIntentGatewayDecision,
    );
    if (repaired) {
      return {
        decision: applyUnstructuredClarificationIfNeeded(repaired, unstructuredClarificationPrompt),
        available: true,
      };
    }
    return {
      decision: {
        route: 'unknown',
        confidence: 'low',
        operation: 'unknown',
        summary: 'Intent gateway response was not structured.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        executionClass: 'direct_assistant',
        preferredTier: 'local',
        requiresRepoGrounding: false,
        requiresToolSynthesis: false,
        expectedContextPressure: 'low',
        preferredAnswerPath: 'direct',
        simpleVsComplex: 'simple',
        provenance: {
          route: classifierSource,
          operation: classifierSource,
        },
        entities: {},
      },
      available: false,
    };
  }
  const decision = normalizeIntentGatewayDecision(parsed, repairContext, { classifierSource });
  if (decision.route === 'unknown') {
    const repaired = repairUnavailableIntentGatewayDecision(
      repairContext,
      parsed,
      normalizeIntentGatewayDecision,
    );
    if (repaired) {
      return {
        decision: applyUnstructuredClarificationIfNeeded(repaired, unstructuredClarificationPrompt),
        available: true,
      };
    }
  }
  return {
    decision,
    available: decision.route !== 'unknown',
    rawStructuredDecision: { ...parsed },
  };
}

export function parseStructuredToolArguments(response: ChatResponse): Record<string, unknown> | null {
  const firstToolCall = response.toolCalls?.[0];
  if (!firstToolCall?.arguments) return null;
  return parseStructuredJsonObject<Record<string, unknown>>(firstToolCall.arguments);
}

export function parseStructuredContent(content: string): Record<string, unknown> | null {
  return parseStructuredJsonObject<Record<string, unknown>>(content);
}

function recoverMalformedStructuredContent(response: ChatResponse): Record<string, unknown> | null {
  return recoverStructuredGatewayPreview(response.toolCalls?.[0]?.arguments)
    ?? recoverStructuredGatewayPreview(response.content);
}

function recoverStructuredGatewayPreview(content: string | undefined): Record<string, unknown> | null {
  if (typeof content !== 'string' || !content.trim()) return null;
  const normalized = content
    .replace(/^\uFEFF/, '')
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, '\'');
  const recovered: Record<string, unknown> = {};
  const matcher = /"([A-Za-z][A-Za-z0-9_]*)"\s*:\s*("(?:\\.|[^"\\])*"|\[[^\]]*\]|true|false|null|-?\d+(?:\.\d+)?)/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(normalized)) !== null) {
    const key = match[1]?.trim();
    const rawValue = match[2]?.trim();
    if (!key || !rawValue) continue;
    const parsedValue = parseRecoveredStructuredScalar(rawValue);
    if (parsedValue === undefined) continue;
    recovered[key] = parsedValue;
  }
  return Object.keys(recovered).length > 0 ? recovered : null;
}

function applyUnstructuredClarificationIfNeeded(
  decision: IntentGatewayDecision,
  clarificationPrompt: string | null,
): IntentGatewayDecision {
  if (!clarificationPrompt) {
    return decision;
  }
  const missingFields = new Set(decision.missingFields);
  for (const field of inferMissingFieldsFromClarificationPrompt(clarificationPrompt, decision.route)) {
    missingFields.add(field);
  }
  return {
    ...decision,
    confidence: decision.confidence === 'high' ? 'medium' : decision.confidence,
    resolution: 'needs_clarification',
    summary: clarificationPrompt,
    missingFields: [...missingFields],
  };
}

function extractUnstructuredClarificationPrompt(content: string | undefined): string | null {
  const normalized = collapseIntentGatewayWhitespace(content ?? '');
  if (!normalized) {
    return null;
  }
  const lower = normalized.toLowerCase();
  const asksForMissingDetail = /\b(?:please tell me|which|what|where|who|do you want me to|would you like me to|should i use|can you clarify|before i can)\b/.test(lower)
    || /\b(?:exact path|external path|full file path|which directory|which provider|which automation|which workspace|which session)\b/.test(lower);
  if (!asksForMissingDetail) {
    return null;
  }
  if (!normalized.includes('?') && !/\bbefore i can\b/.test(lower)) {
    return null;
  }
  if (/\b(?:what else can i help with|let me know if|if you want,? i can)\b/.test(lower)) {
    return null;
  }
  return normalized;
}

function inferMissingFieldsFromClarificationPrompt(
  prompt: string,
  route: IntentGatewayDecision['route'],
): string[] {
  const normalized = prompt.toLowerCase();
  const inferred = new Set<string>();
  if (/\b(?:exact\s+external\s+path|external\s+path|full\s+file\s+path|file\s+path|path|directory|folder|location|workspace root|project root|repo root)\b/.test(normalized)) {
    inferred.add('path');
  }
  if (/\b(?:gmail|outlook|google workspace|microsoft 365|email provider|mail provider)\b/.test(normalized)) {
    inferred.add('email_provider');
  }
  if (/\b(?:automation|workflow|routine)\b/.test(normalized) && /\b(?:which|what|name)\b/.test(normalized)) {
    inferred.add('automation_name');
  }
  if (/\b(?:coding backend|codex|claude(?:\s+code)?|gemini(?:\s+cli)?|aider)\b/.test(normalized)) {
    inferred.add('coding_backend');
  }
  if (/\b(?:workspace|session)\b/.test(normalized) && /\b(?:which|what|target|use)\b/.test(normalized)) {
    inferred.add('session_target');
  }
  if (
    /\b(?:guardian page|external website|repo|repository|workspace\/session|new or existing|create or update)\b/.test(normalized)
    && /\bor\b/.test(normalized)
  ) {
    inferred.add('intent_route');
  }
  if (inferred.size === 0) {
    switch (route) {
      case 'filesystem_task':
        inferred.add('path');
        break;
      case 'email_task':
        inferred.add('email_provider');
        break;
      case 'automation_control':
        inferred.add('automation_name');
        break;
      default:
        break;
    }
  }
  return [...inferred];
}

function parseRecoveredStructuredScalar(rawValue: string): unknown {
  try {
    return JSON.parse(rawValue) as unknown;
  } catch {
    if (rawValue.startsWith('\'') && rawValue.endsWith('\'')) {
      try {
        return JSON.parse(`"${rawValue.slice(1, -1).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`) as unknown;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

export function normalizeIntentGatewayDecision(
  parsed: Record<string, unknown>,
  repairContext?: IntentGatewayRepairContext,
  options?: {
    classifierSource?: IntentGatewayProvenanceSource;
  },
): IntentGatewayDecision {
  const classifierSource = options?.classifierSource ?? 'classifier.primary';
  const parsedOperation = normalizeOperation(parsed.operation);
  const confidence = normalizeConfidence(parsed.confidence);
  const summary = typeof parsed.summary === 'string' && parsed.summary.trim()
    ? parsed.summary.trim()
    : INTENT_GATEWAY_MISSING_SUMMARY;
  const recoveryReason = typeof parsed.recoveryReason === 'string' && parsed.recoveryReason.trim()
    ? parsed.recoveryReason.trim()
    : undefined;
  const turnRelation = normalizeTurnRelation(parsed.turnRelation);
  const normalizedParsedRoute = normalizeRoute(parsed.route);
  const semanticallyRepairedRoute = repairStructuredIntentGatewayRoute(
    normalizedParsedRoute,
    parsedOperation,
    turnRelation,
    repairContext,
  );
  const route = repairIntentGatewayRoute(
    semanticallyRepairedRoute,
    turnRelation,
    repairContext,
  );
  const semanticallyRepairedOperation = repairStructuredIntentGatewayOperation(
    parsedOperation,
    route,
    turnRelation,
    repairContext,
  );
  const operation = repairIntentGatewayOperation(
    semanticallyRepairedOperation,
    route,
    turnRelation,
    repairContext,
  );
  const resolution = normalizeResolution(parsed.resolution);
  const missingFields = Array.isArray(parsed.missingFields)
    ? parsed.missingFields
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean)
    : [];
  const resolvedContent = typeof parsed.resolvedContent === 'string' && parsed.resolvedContent.trim()
    ? parsed.resolvedContent.trim()
    : undefined;
  const entityResolution = resolveIntentGatewayEntities(
    parsed,
    repairContext,
    route,
    operation,
    classifierSource,
  );
  const derivedWorkload = deriveWorkloadMetadata(route, operation, {
    ...parsed,
    ...entityResolution.entities,
  });
  const normalizedExecutionClass = normalizeExecutionClass(parsed.executionClass);
  const executionClass = normalizedExecutionClass ?? derivedWorkload.executionClass;
  const normalizedPreferredTier = normalizePreferredTier(parsed.preferredTier);
  const preferredTier = normalizedPreferredTier ?? derivedWorkload.preferredTier;
  const hasParsedRequiresRepoGrounding = typeof parsed.requiresRepoGrounding === 'boolean';
  const requiresRepoGrounding = hasParsedRequiresRepoGrounding
    ? parsed.requiresRepoGrounding as boolean
    : derivedWorkload.requiresRepoGrounding;
  const hasParsedRequiresToolSynthesis = typeof parsed.requiresToolSynthesis === 'boolean';
  const requiresToolSynthesis = hasParsedRequiresToolSynthesis
    ? parsed.requiresToolSynthesis as boolean
    : derivedWorkload.requiresToolSynthesis;
  const heuristicRequiresExactFile = (
    (requiresRepoGrounding || executionClass === 'repo_grounded' || executionClass === 'security_analysis')
    && requestNeedsExactFileReferences(repairContext?.sourceContent)
  );
  const hasParsedRequireExactFileReferences = typeof parsed.requireExactFileReferences === 'boolean';
  // Use the model's parsed value, but force it to true if the heuristic strongly believes it requires exact file references.
  const requireExactFileReferences = (hasParsedRequireExactFileReferences && parsed.requireExactFileReferences as boolean)
    || heuristicRequiresExactFile;
  const expectedContextPressure = normalizeExpectedContextPressure(parsed.expectedContextPressure)
    ?? derivedWorkload.expectedContextPressure;
  const preferredAnswerPath = normalizePreferredAnswerPath(parsed.preferredAnswerPath)
    ?? derivedWorkload.preferredAnswerPath;
  const simpleVsComplex = normalizeSimpleVsComplex(parsed.simpleVsComplex)
    ?? derivedWorkload.simpleVsComplex;
  const rawPlannedSteps = Array.isArray(parsed.planned_steps)
    ? parsed.planned_steps
    : Array.isArray(parsed.plannedSteps)
      ? parsed.plannedSteps
      : [];
  const plannedSteps = rawPlannedSteps
    .filter((value): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value))
    .map((step) => {
      const summary = typeof step.summary === 'string' ? step.summary.trim() : '';
      const kind = normalizePlannedStepKind(step.kind);
      if (!summary || !kind) return null;
      const expectedToolCategories = Array.isArray(step.expectedToolCategories)
        ? step.expectedToolCategories
            .filter((value): value is string => typeof value === 'string')
            .map((value) => value.trim())
            .filter(Boolean)
        : [];
      const dependsOn = Array.isArray(step.dependsOn)
        ? step.dependsOn
            .filter((value): value is string => typeof value === 'string')
            .map((value) => value.trim())
            .filter(Boolean)
        : [];
      return {
        kind,
        summary,
        ...(expectedToolCategories.length > 0 ? { expectedToolCategories } : {}),
        ...(typeof step.required === 'boolean' ? { required: step.required } : {}),
        ...(dependsOn.length > 0 ? { dependsOn } : {}),
      };
    })
    .filter((step): step is IntentGatewayPlannedStep => !!step);
  const synthesizedPlannedSteps = plannedSteps.length > 0
    ? []
    : synthesizeIntentGatewayPlannedSteps({
        sourceContent: repairContext?.sourceContent,
        route,
        operation,
        executionClass,
        requireExactFileReferences,
        requiresRepoGrounding,
      });
  const effectivePlannedSteps = plannedSteps.length > 0 ? plannedSteps : synthesizedPlannedSteps;
  const clarificationPendingRoute = normalizeRoute(repairContext?.pendingAction?.route);
  const clarificationPendingOperation = normalizeOperation(repairContext?.pendingAction?.operation);
  const clarificationOwnsRoute = (turnRelation === 'clarification_answer' || turnRelation === 'correction')
    && clarificationPendingRoute !== 'unknown'
    && route === clarificationPendingRoute;
  const clarificationOwnsOperation = clarificationOwnsRoute
    && clarificationPendingOperation !== 'unknown'
    && operation === clarificationPendingOperation;
  const provenance = {
    route: route === normalizedParsedRoute
      ? classifierSource
      : clarificationOwnsRoute
        ? 'resolver.clarification'
        : route === semanticallyRepairedRoute
        ? 'repair.structured'
        : 'resolver.clarification',
    operation: operation === parsedOperation
      ? classifierSource
      : clarificationOwnsOperation
        ? 'resolver.clarification'
        : operation === semanticallyRepairedOperation
        ? 'repair.structured'
        : 'resolver.clarification',
    ...(resolvedContent ? { resolvedContent: classifierSource } : {}),
    executionClass: normalizedExecutionClass ? classifierSource : 'derived.workload',
    preferredTier: normalizedPreferredTier ? classifierSource : 'derived.workload',
    requiresRepoGrounding: hasParsedRequiresRepoGrounding ? classifierSource : 'derived.workload',
    requiresToolSynthesis: hasParsedRequiresToolSynthesis ? classifierSource : 'derived.workload',
    ...(hasParsedRequireExactFileReferences || requireExactFileReferences
      ? {
          requireExactFileReferences: (hasParsedRequireExactFileReferences && parsed.requireExactFileReferences as boolean === requireExactFileReferences)
            ? classifierSource
            : 'derived.workload',
        }
      : {}),
    expectedContextPressure: normalizeExpectedContextPressure(parsed.expectedContextPressure)
      ? classifierSource
      : 'derived.workload',
    preferredAnswerPath: normalizePreferredAnswerPath(parsed.preferredAnswerPath)
      ? classifierSource
      : 'derived.workload',
    simpleVsComplex: normalizeSimpleVsComplex(parsed.simpleVsComplex)
      ? classifierSource
      : 'derived.workload',
    ...(entityResolution.provenance ? { entities: entityResolution.provenance } : {}),
  } satisfies NonNullable<IntentGatewayDecision['provenance']>;

  return {
    route,
    confidence,
    operation,
    summary,
    turnRelation,
    resolution,
    missingFields,
    executionClass,
    preferredTier,
    requiresRepoGrounding,
    requiresToolSynthesis,
    requireExactFileReferences,
    expectedContextPressure,
    preferredAnswerPath,
    simpleVsComplex,
    ...(effectivePlannedSteps.length > 0 ? { plannedSteps: effectivePlannedSteps } : {}),
    ...(recoveryReason ? { recoveryReason } : {}),
    provenance,
    ...(resolvedContent ? { resolvedContent } : {}),
    entities: entityResolution.entities,
  };
}

export function buildRawResponsePreview(response: ChatResponse): string | undefined {
  const toolArguments = response.toolCalls?.[0]?.arguments?.trim();
  if (toolArguments) return toolArguments.slice(0, 200);
  const content = response.content.trim();
  return content ? content.slice(0, 200) : undefined;
}

function normalizePlannedStepKind(value: unknown): IntentGatewayPlannedStep['kind'] | null {
  switch (value) {
    case 'tool_call':
    case 'write':
    case 'read':
    case 'search':
    case 'memory_save':
    case 'answer':
      return value;
    default:
      return null;
  }
}

function synthesizeIntentGatewayPlannedSteps(input: {
  sourceContent?: string;
  route: IntentGatewayDecision['route'];
  operation: IntentGatewayDecision['operation'];
  executionClass: IntentGatewayDecision['executionClass'];
  requireExactFileReferences: boolean;
  requiresRepoGrounding: boolean;
}): IntentGatewayPlannedStep[] {
  const sourceContent = collapseIntentGatewayWhitespace(input.sourceContent ?? '');
  if (!sourceContent) return [];

  const sequentialClauses = splitSequentialRequestClauses(sourceContent);
  if (sequentialClauses.length >= 2) {
    return sequentialClauses.map((summary, index) => {
      const kind = inferSynthesizedPlannedStepKind(summary, input.route, input.operation);
      return {
        kind,
        summary,
        required: true,
        ...(index > 0 ? { dependsOn: [`step_${index}`] } : {}),
        ...buildSynthesizedExpectedToolCategories(kind),
      };
    });
  }

  if (input.requiresRepoGrounding || input.executionClass === 'repo_grounded' || input.executionClass === 'security_analysis') {
    const evidenceSummary = input.executionClass === 'security_analysis' || input.route === 'security_task'
      ? 'Inspect the relevant repo files and collect grounded security evidence.'
      : 'Inspect the relevant repo files and collect grounded repo evidence.';
    const answerSummary = input.requireExactFileReferences
      ? 'Answer with exact file names, file paths, and symbol names grounded in the repo evidence.'
      : 'Answer with grounded findings from the inspected repo files.';
    return [
      {
        kind: isExplicitRepoInspectionRequest(sourceContent) ? 'search' : 'read',
        summary: evidenceSummary,
        required: true,
        expectedToolCategories: ['search', 'read'],
      },
      {
        kind: 'answer',
        summary: answerSummary,
        required: true,
        dependsOn: ['step_1'],
      },
    ];
  }

  return [];
}

const MODIFIER_CLAUSE_LEADERS = [
  'cite',
  'also',
  'with ',
  'without ',
  'grounded in',
  'backed by',
  'using ',
  'based on',
  'relying on',
  'including',
  'specifically',
  'in particular',
  'do not ',
  "don't ",
  'ensure ',
  'make sure ',
  'please ',
  'and cite ',
  'and name ',
  'and list ',
  'and show ',
  'and identify ',
];

const READONLY_CLAUSE_PATTERNS = [
  /\bdo\s+not\s+edit\b/i,
  /\bdon'?t\s+edit\b/i,
  /\bread[\s-]*only\b/i,
  /\bwithout\s+(?:editing|modifications?|changes?|writes?)\b/i,
  /\bno\s+(?:editing|modifications?|changes?|writes?)\b/i,
];

function isModifierClause(clause: string): boolean {
  const lower = clause.trim().toLowerCase();
  if (!lower) return false;
  return MODIFIER_CLAUSE_LEADERS.some((leader) => lower.startsWith(leader));
}

function isReadonlyModifierClause(clause: string): boolean {
  const trimmed = clause.trim();
  if (!trimmed) return false;
  return READONLY_CLAUSE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function isAnswerConstraintClause(clause: string): boolean {
  const lower = clause.trim().toLowerCase();
  if (!lower) return false;
  // "Cite exact file names and symbol names" → modifier that should be a constraint, not a step
  if (/\b(cite|name|list|identify|show)\s+.*\b(file|files|symbol|function|type|class|interface)\b/i.test(lower)) {
    return true;
  }
  // "Do not edit anything" and similar readonly patterns → constraint, not a step
  if (isReadonlyModifierClause(clause)) {
    return true;
  }
  return false;
}

export function splitSequentialRequestClauses(sourceContent: string): string[] {
  const normalized = sourceContent
    .replace(/\r\n/g, '\n')
    .replace(/\b(?:then|next|after that|finally)\b[:,]?\s+/gi, '\n')
    .replace(/\n+/g, '\n');
  const rawClauses = normalized
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'])|\n+/)
    .map((value) => collapseIntentGatewayWhitespace(value))
    .filter(Boolean);
  if (rawClauses.length < 2) return [];

  const merged: string[] = [];
  for (const clause of rawClauses) {
    // Readonly modifiers like "Do not edit anything" are answer constraints, not steps.
    // Drop them from the plan entirely — they'll be captured in answerConstraints.
    if (isReadonlyModifierClause(clause)) {
      continue;
    }
    if (merged.length > 0 && isModifierClause(clause)) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${clause}`.trim();
      continue;
    }
    // Answer constraint clauses like "Cite exact file names and symbol names" modify
    // the answer step rather than being a standalone step. Merge them into the prior clause.
    if (merged.length > 0 && isAnswerConstraintClause(clause)) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${clause}`.trim();
      continue;
    }
    merged.push(clause);
  }
  if (merged.length < 2) return [];
  return merged.slice(0, 6);
}

function inferSynthesizedPlannedStepKind(
  summary: string,
  route: IntentGatewayDecision['route'],
  operation: IntentGatewayDecision['operation'],
): IntentGatewayPlannedStep['kind'] {
  const normalized = summary.toLowerCase();
  if (/\b(?:write|create|update|edit|patch|modify|append|delete|remove|touch|save (?:a |the )?(?:file|summary|report|note))\b/.test(normalized)) {
    return 'write';
  }
  if (/\b(?:remember|save to memory|store in memory|save (?:a |the )?(?:global |project )?memory)\b/.test(normalized)) {
    return 'memory_save';
  }
  if (/\b(?:search|find|grep|scan|trace|locate)\b/.test(normalized)) {
    return 'search';
  }
  if (/\b(?:read|open|inspect|review|check|look at)\b/.test(normalized)) {
    return 'read';
  }
  if (/\b(?:tell me|report|answer|explain|summari[sz]e|return)\b/.test(normalized)) {
    return 'answer';
  }
  if (route === 'filesystem_task' && operation !== 'read' && operation !== 'search' && operation !== 'inspect') {
    return 'write';
  }
  if (route === 'coding_task' || route === 'security_task') {
    return 'read';
  }
  return 'answer';
}

function buildSynthesizedExpectedToolCategories(
  kind: IntentGatewayPlannedStep['kind'],
): Partial<IntentGatewayPlannedStep> {
  switch (kind) {
    case 'write':
      return { expectedToolCategories: ['write'] };
    case 'read':
      return { expectedToolCategories: ['read'] };
    case 'search':
      return { expectedToolCategories: ['search', 'read'] };
    case 'memory_save':
      return { expectedToolCategories: ['memory_save'] };
    default:
      return {};
  }
}
