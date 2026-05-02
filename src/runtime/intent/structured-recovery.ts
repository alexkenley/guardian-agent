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
import { hasRequiredWritePlannedStep } from './planned-steps.js';
import { collapseIntentGatewayWhitespace } from './text.js';
import {
  isConversationTranscriptReferenceRequest,
  isExplicitExternalPromptInjectionRequest,
  isExplicitRepoInspectionRequest,
  isRawCredentialDisclosureRequest,
  requestNeedsExactFileReferences,
} from './request-patterns.js';
import { isExplicitProviderConfigRequest } from './entity-resolvers/provider-config.js';
import type {
  IntentGatewayDecision,
  IntentGatewayPlannedStep,
  IntentGatewayProvenanceSource,
  IntentGatewayRepairContext,
  IntentGatewayRecord,
} from './types.js';
import { deriveWorkloadMetadata } from './workload-derivation.js';

export function parseIntentGatewayDecision(
  response: ChatResponse,
  repairContext?: IntentGatewayRepairContext,
  options?: { mode?: IntentGatewayRecord['mode'] },
): { decision: IntentGatewayDecision; available: boolean; rawStructuredDecision?: Record<string, unknown> } {
  const classifierSource = classifierProvenanceSourceForMode(options?.mode ?? 'primary');
  const parsed = parseStructuredToolArguments(response)
    ?? parseStructuredContent(response.content)
    ?? recoverMalformedStructuredContent(response);
  if (!parsed) {
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
  const parsedTurnRelation = normalizeTurnRelation(parsed.turnRelation);
  const turnRelation = repairTurnRelationForConversationReference(
    parsedTurnRelation,
    repairContext,
  );
  const normalizedParsedRoute = normalizeRoute(parsed.route);
  const semanticallyRepairedRoute = repairStructuredIntentGatewayRoute(
    normalizedParsedRoute,
    parsedOperation,
    turnRelation,
    repairContext,
    parsed,
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
    parsed,
  );
  const operation = repairIntentGatewayOperation(
    semanticallyRepairedOperation,
    route,
    turnRelation,
    repairContext,
  );
  const rawCredentialDisclosure = isRawCredentialDisclosureRequest(repairContext?.sourceContent);
  const directSecurityRefusal = rawCredentialDisclosure
    || isExplicitExternalPromptInjectionRequest(repairContext?.sourceContent);
  const routeOrOperationRepaired = route !== normalizedParsedRoute || operation !== parsedOperation;
  const resolution = normalizeResolution(parsed.resolution);
  const missingFields = Array.isArray(parsed.missingFields)
    ? parsed.missingFields
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean)
    : [];
  const clarificationContradictsCurrentRequest = shouldRepairMissingCurrentRequestContentClarification({
    resolution,
    missingFields,
    sourceContent: repairContext?.sourceContent,
    hasPendingAction: !!repairContext?.pendingAction,
  });
  const effectiveMissingFields = clarificationContradictsCurrentRequest
    ? missingFields.filter((field) => !isCurrentRequestContentMissingField(field))
    : missingFields;
  const effectiveResolution = clarificationContradictsCurrentRequest && effectiveMissingFields.length <= 0
    ? 'ready'
    : resolution;
  const rawResolvedContent = typeof parsed.resolvedContent === 'string' && parsed.resolvedContent.trim()
    ? parsed.resolvedContent.trim()
    : undefined;
  const resolvedContent = shouldAcceptResolvedContent({
    content: rawResolvedContent,
    turnRelation,
    hasPendingAction: !!repairContext?.pendingAction,
  })
    ? rawResolvedContent
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
  const explicitProviderConfigRequest = route === 'general_assistant'
    && isExplicitProviderConfigRequest(repairContext?.sourceContent);
  const useDerivedWorkload = routeOrOperationRepaired || explicitProviderConfigRequest;
  const normalizedExecutionClass = normalizeExecutionClass(parsed.executionClass);
  const executionClass = directSecurityRefusal
    ? 'security_analysis'
    : !useDerivedWorkload && normalizedExecutionClass
    ? normalizedExecutionClass
    : derivedWorkload.executionClass;
  const normalizedPreferredTier = normalizePreferredTier(parsed.preferredTier);
  const preferredTier = directSecurityRefusal
    ? 'external'
    : !useDerivedWorkload && normalizedPreferredTier
    ? normalizedPreferredTier
    : derivedWorkload.preferredTier;
  const hasParsedRequiresRepoGrounding = !useDerivedWorkload && typeof parsed.requiresRepoGrounding === 'boolean';
  const requiresRepoGrounding = directSecurityRefusal
    ? false
    : hasParsedRequiresRepoGrounding
    ? parsed.requiresRepoGrounding as boolean
    : derivedWorkload.requiresRepoGrounding;
  const hasParsedRequiresToolSynthesis = !useDerivedWorkload && typeof parsed.requiresToolSynthesis === 'boolean';
  const requiresToolSynthesis = directSecurityRefusal
    ? false
    : hasParsedRequiresToolSynthesis
    ? parsed.requiresToolSynthesis as boolean
    : derivedWorkload.requiresToolSynthesis;
  const heuristicRequiresExactFile = (
    (
      requiresRepoGrounding
      || executionClass === 'repo_grounded'
      || (executionClass === 'security_analysis' && requiresToolSynthesis)
    )
    && requestNeedsExactFileReferences(repairContext?.sourceContent)
  );
  const hasParsedRequireExactFileReferences = typeof parsed.requireExactFileReferences === 'boolean';
  // Use the model's parsed value, but force it to true if the heuristic strongly believes it requires exact file references.
  const requireExactFileReferences = (hasParsedRequireExactFileReferences && parsed.requireExactFileReferences as boolean)
    || heuristicRequiresExactFile;
  const normalizedExpectedContextPressure = normalizeExpectedContextPressure(parsed.expectedContextPressure);
  const expectedContextPressure = directSecurityRefusal
    ? 'low'
    : !useDerivedWorkload && normalizedExpectedContextPressure
    ? normalizedExpectedContextPressure
    : derivedWorkload.expectedContextPressure;
  const normalizedPreferredAnswerPath = normalizePreferredAnswerPath(parsed.preferredAnswerPath);
  const preferredAnswerPath = directSecurityRefusal
    ? 'direct'
    : !useDerivedWorkload && normalizedPreferredAnswerPath
    ? normalizedPreferredAnswerPath
    : derivedWorkload.preferredAnswerPath;
  const normalizedSimpleVsComplex = normalizeSimpleVsComplex(parsed.simpleVsComplex);
  const simpleVsComplex = directSecurityRefusal
    ? 'simple'
    : !useDerivedWorkload && normalizedSimpleVsComplex
    ? normalizedSimpleVsComplex
    : derivedWorkload.simpleVsComplex;
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
  const synthesizedPlannedSteps = synthesizeIntentGatewayPlannedSteps({
    sourceContent: repairContext?.sourceContent,
    route,
    operation,
    executionClass,
    requireExactFileReferences,
    requiresRepoGrounding,
    requiresToolSynthesis,
  });
  const selectedPlannedSteps = shouldSuppressSecurityEvidencePlan({
    route,
    executionClass,
    requiresRepoGrounding,
    requiresToolSynthesis,
  })
    ? plannedSteps.filter((step) => step.kind === 'answer')
    : shouldPreferSynthesizedPlannedSteps(plannedSteps, synthesizedPlannedSteps)
    ? synthesizedPlannedSteps
    : plannedSteps.length > 0
      ? plannedSteps
      : synthesizedPlannedSteps;
  const effectivePlannedSteps = normalizePlannedStepsForDecision(selectedPlannedSteps, {
    route,
    operation,
    personalItemType: entityResolution.entities.personalItemType,
    configuredSearchSources: repairContext?.configuredSearchSources,
  });
  const searchSurfaceClarification = buildSearchSurfaceClarification({
    route,
    confidence,
    operation,
    resolution: effectiveResolution,
    plannedSteps: effectivePlannedSteps,
    configuredSearchSources: repairContext?.configuredSearchSources,
  });
  const plannedStepsRequireRepoGrounding = !directSecurityRefusal
    && planRequiresRepoGrounding(effectivePlannedSteps);
  const effectiveRequiresRepoGrounding = directSecurityRefusal
    ? false
    : requiresRepoGrounding || plannedStepsRequireRepoGrounding;
  const effectiveRequireExactFileReferences = requireExactFileReferences || (
    effectiveRequiresRepoGrounding
    && requestNeedsExactFileReferences(repairContext?.sourceContent)
  );
  const structuredWritePlanRoute = route === 'unknown' && hasRequiredWritePlannedStep({
    plannedSteps: effectivePlannedSteps,
  } as IntentGatewayDecision)
    ? 'filesystem_task' as const
    : null;
  const effectiveRoute = structuredWritePlanRoute ?? route;
  const readOnlyEvidenceOperation = deriveReadOnlyEvidenceOperation({
    route: effectiveRoute,
    operation,
    plannedSteps: effectivePlannedSteps,
    parsed,
  });
  const effectiveOperation = structuredWritePlanRoute && operation === 'unknown'
    ? 'create'
    : readOnlyEvidenceOperation
      ? readOnlyEvidenceOperation
    : operation;
  const toolBackedAnswerPlan = requiresToolBackedAnswerPlan(effectiveRoute, effectivePlannedSteps);
  const structurallyDirectAnswer = isStructurallyDirectAssistantTurn({
    executionClass,
    requiresRepoGrounding: effectiveRequiresRepoGrounding,
    requiresToolSynthesis,
    plannedSteps: effectivePlannedSteps,
  });
  const effectiveExecutionClass = structuredWritePlanRoute
    ? 'tool_orchestration'
    : effectiveRequiresRepoGrounding && executionClass === 'direct_assistant'
    ? 'tool_orchestration'
    : toolBackedAnswerPlan ? 'tool_orchestration' : executionClass;
  const effectivePreferredTier = structuredWritePlanRoute
    ? 'external'
    : effectiveRequiresRepoGrounding && preferredTier === 'local'
    ? 'external'
    : toolBackedAnswerPlan ? 'external' : preferredTier;
  const effectiveRequiresToolSynthesis = structuredWritePlanRoute
    ? true
    : toolBackedAnswerPlan ? true : requiresToolSynthesis;
  const effectiveExpectedContextPressure = toolBackedAnswerPlan
    ? 'medium'
    : structuredWritePlanRoute
      ? 'medium'
    : structurallyDirectAnswer && preferredAnswerPath !== 'direct'
      ? derivedWorkload.expectedContextPressure
    : effectiveRequiresRepoGrounding && expectedContextPressure === 'low'
      ? 'medium'
      : expectedContextPressure;
  const effectivePreferredAnswerPath = toolBackedAnswerPlan
    ? 'tool_loop'
    : structuredWritePlanRoute
      ? 'tool_loop'
    : structurallyDirectAnswer
      ? 'direct'
      : preferredAnswerPath;
  const effectiveSimpleVsComplex = toolBackedAnswerPlan
    ? 'complex'
    : structuredWritePlanRoute
      ? 'complex'
    : structurallyDirectAnswer && preferredAnswerPath !== 'direct'
      ? derivedWorkload.simpleVsComplex
      : simpleVsComplex;
  const finalResolution = searchSurfaceClarification
    ? 'needs_clarification' as const
    : effectiveResolution;
  const finalMissingFields = searchSurfaceClarification
    ? [...new Set([...effectiveMissingFields, 'search_surface'])]
    : effectiveMissingFields;
  const finalSummary = searchSurfaceClarification?.prompt ?? summary;
  const clarificationPendingRoute = normalizeRoute(repairContext?.pendingAction?.route);
  const clarificationPendingOperation = normalizeOperation(repairContext?.pendingAction?.operation);
  const clarificationOwnsRoute = (turnRelation === 'clarification_answer' || turnRelation === 'correction')
    && clarificationPendingRoute !== 'unknown'
    && route === clarificationPendingRoute;
  const clarificationOwnsOperation = clarificationOwnsRoute
    && clarificationPendingOperation !== 'unknown'
    && operation === clarificationPendingOperation;
  const provenance = {
    route: structuredWritePlanRoute
      ? 'derived.workload'
      : route === normalizedParsedRoute
      ? classifierSource
      : clarificationOwnsRoute
        ? 'resolver.clarification'
        : route === semanticallyRepairedRoute
        ? 'repair.structured'
        : 'resolver.clarification',
    operation: structuredWritePlanRoute && operation === 'unknown'
      ? 'derived.workload'
      : readOnlyEvidenceOperation
      ? 'derived.workload'
      : operation === parsedOperation
      ? classifierSource
      : clarificationOwnsOperation
        ? 'resolver.clarification'
        : operation === semanticallyRepairedOperation
        ? 'repair.structured'
        : 'resolver.clarification',
    ...(resolvedContent ? { resolvedContent: classifierSource } : {}),
    executionClass: structuredWritePlanRoute
      ? 'derived.workload'
      : effectiveRequiresRepoGrounding && executionClass === 'direct_assistant'
      ? 'derived.workload'
      : toolBackedAnswerPlan
      ? 'derived.workload'
      : directSecurityRefusal
      ? 'derived.workload'
      : (!useDerivedWorkload && normalizedExecutionClass) ? classifierSource : 'derived.workload',
    preferredTier: structuredWritePlanRoute
      ? 'derived.workload'
      : effectiveRequiresRepoGrounding && preferredTier === 'local'
      ? 'derived.workload'
      : toolBackedAnswerPlan
      ? 'derived.workload'
      : directSecurityRefusal
      ? 'derived.workload'
      : (!useDerivedWorkload && normalizedPreferredTier) ? classifierSource : 'derived.workload',
    requiresRepoGrounding: directSecurityRefusal
      ? 'derived.workload'
      : plannedStepsRequireRepoGrounding && !requiresRepoGrounding
      ? 'derived.workload'
      : hasParsedRequiresRepoGrounding ? classifierSource : 'derived.workload',
    requiresToolSynthesis: structuredWritePlanRoute
      ? 'derived.workload'
      : toolBackedAnswerPlan
      ? 'derived.workload'
      : directSecurityRefusal
      ? 'derived.workload'
      : hasParsedRequiresToolSynthesis ? classifierSource : 'derived.workload',
    ...(hasParsedRequireExactFileReferences || effectiveRequireExactFileReferences
      ? {
          requireExactFileReferences: (hasParsedRequireExactFileReferences && parsed.requireExactFileReferences as boolean === effectiveRequireExactFileReferences)
            ? classifierSource
            : 'derived.workload',
        }
      : {}),
    expectedContextPressure: structuredWritePlanRoute || toolBackedAnswerPlan || (structurallyDirectAnswer && preferredAnswerPath !== 'direct') || (effectiveRequiresRepoGrounding && expectedContextPressure === 'low')
      ? 'derived.workload'
      : directSecurityRefusal
      ? 'derived.workload'
      : (!useDerivedWorkload && normalizedExpectedContextPressure)
      ? classifierSource
      : 'derived.workload',
    preferredAnswerPath: structuredWritePlanRoute || toolBackedAnswerPlan || (structurallyDirectAnswer && preferredAnswerPath !== 'direct')
      ? 'derived.workload'
      : directSecurityRefusal
      ? 'derived.workload'
      : (!useDerivedWorkload && normalizedPreferredAnswerPath)
      ? classifierSource
      : 'derived.workload',
    simpleVsComplex: structuredWritePlanRoute || toolBackedAnswerPlan || (structurallyDirectAnswer && preferredAnswerPath !== 'direct')
      ? 'derived.workload'
      : directSecurityRefusal
      ? 'derived.workload'
      : (!useDerivedWorkload && normalizedSimpleVsComplex)
      ? classifierSource
      : 'derived.workload',
    ...(entityResolution.provenance ? { entities: entityResolution.provenance } : {}),
  } satisfies NonNullable<IntentGatewayDecision['provenance']>;

  return {
    route: effectiveRoute,
    confidence,
    operation: effectiveOperation,
    summary: finalSummary,
    turnRelation,
    resolution: finalResolution,
    missingFields: finalMissingFields,
    executionClass: effectiveExecutionClass,
    preferredTier: effectivePreferredTier,
    requiresRepoGrounding: effectiveRequiresRepoGrounding,
    requiresToolSynthesis: effectiveRequiresToolSynthesis,
    requireExactFileReferences: effectiveRequireExactFileReferences,
    expectedContextPressure: effectiveExpectedContextPressure,
    preferredAnswerPath: effectivePreferredAnswerPath,
    simpleVsComplex: effectiveSimpleVsComplex,
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

function shouldAcceptResolvedContent(input: {
  content?: string;
  turnRelation: IntentGatewayDecision['turnRelation'];
  hasPendingAction: boolean;
}): boolean {
  if (!input.content?.trim()) return false;
  if (input.turnRelation === 'clarification_answer' || input.turnRelation === 'correction') {
    return true;
  }
  return input.hasPendingAction && input.turnRelation !== 'new_request';
}

function repairTurnRelationForConversationReference(
  turnRelation: IntentGatewayDecision['turnRelation'],
  repairContext: IntentGatewayRepairContext | undefined,
): IntentGatewayDecision['turnRelation'] {
  if (turnRelation !== 'new_request' || !repairContext?.continuity) {
    return turnRelation;
  }
  return isConversationTranscriptReferenceRequest(repairContext.sourceContent)
    ? 'follow_up'
    : turnRelation;
}

function shouldRepairMissingCurrentRequestContentClarification(input: {
  resolution: IntentGatewayDecision['resolution'];
  missingFields: string[];
  sourceContent?: string;
  hasPendingAction: boolean;
}): boolean {
  if (input.hasPendingAction || input.resolution !== 'needs_clarification') return false;
  if (!input.missingFields.some(isCurrentRequestContentMissingField)) return false;
  return collapseIntentGatewayWhitespace(input.sourceContent ?? '').length > 0;
}

function isCurrentRequestContentMissingField(field: string): boolean {
  const normalized = field.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return normalized === 'user_request'
    || normalized === 'request_content'
    || normalized === 'request'
    || normalized === 'message'
    || normalized === 'prompt'
    || normalized === 'user_prompt'
    || normalized === 'task'
    || normalized === 'instruction';
}

function isStructurallyDirectAssistantTurn(input: {
  executionClass: IntentGatewayDecision['executionClass'];
  requiresRepoGrounding: boolean;
  requiresToolSynthesis: boolean;
  plannedSteps: IntentGatewayPlannedStep[];
}): boolean {
  if (input.executionClass !== 'direct_assistant') return false;
  if (input.requiresRepoGrounding || input.requiresToolSynthesis) return false;
  return input.plannedSteps.every((step) => step.required === false || step.kind === 'answer');
}

function deriveReadOnlyEvidenceOperation(input: {
  route: IntentGatewayDecision['route'];
  operation: IntentGatewayDecision['operation'];
  plannedSteps: IntentGatewayPlannedStep[];
  parsed: Record<string, unknown>;
}): IntentGatewayDecision['operation'] | null {
  if (input.operation !== 'run') return null;
  if (input.route !== 'general_assistant' && input.route !== 'complex_planning_task') return null;
  if (hasExplicitExecutionTarget(input.parsed)) return null;

  const requiredSteps = input.plannedSteps.filter((step) => step.required !== false);
  if (requiredSteps.length === 0) return null;
  const evidenceSteps = requiredSteps.filter((step) => step.kind !== 'answer');
  if (evidenceSteps.length === 0) return null;
  if (!requiredSteps.every((step) => step.kind === 'read' || step.kind === 'search' || step.kind === 'answer')) {
    return null;
  }
  if (requiredSteps.some((step) => step.expectedToolCategories?.some(isMutationPlanCategory))) {
    return null;
  }
  return evidenceSteps.some((step) => step.kind === 'search') ? 'search' : 'inspect';
}

function hasExplicitExecutionTarget(parsed: Record<string, unknown>): boolean {
  return (typeof parsed.toolName === 'string' && parsed.toolName.trim().length > 0)
    || typeof parsed.codingBackend === 'string'
    || parsed.codingBackendRequested === true
    || parsed.codingRemoteExecRequested === true;
}

function isMutationPlanCategory(category: string): boolean {
  switch (category.trim()) {
    case 'write':
    case 'tool_call':
    case 'memory_save':
    case 'fs_write':
    case 'fs_mkdir':
    case 'fs_delete':
    case 'fs_move':
    case 'fs_copy':
    case 'automation_save':
    case 'automation_create':
    case 'automation_update':
    case 'automation_delete':
    case 'email_send':
    case 'calendar_create':
    case 'calendar_update':
    case 'calendar_delete':
      return true;
    default:
      return false;
  }
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
  requiresToolSynthesis: boolean;
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
        ...buildSynthesizedExpectedToolCategories(kind, summary),
      };
    });
  }

  if (
    input.requiresRepoGrounding
    || input.executionClass === 'repo_grounded'
    || (input.executionClass === 'security_analysis' && input.requiresToolSynthesis)
  ) {
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

function shouldSuppressSecurityEvidencePlan(input: {
  route: IntentGatewayDecision['route'];
  executionClass: IntentGatewayDecision['executionClass'];
  requiresRepoGrounding: boolean;
  requiresToolSynthesis: boolean;
}): boolean {
  return (input.route === 'security_task' || input.executionClass === 'security_analysis')
    && !input.requiresRepoGrounding
    && !input.requiresToolSynthesis;
}

function shouldPreferSynthesizedPlannedSteps(
  parsedSteps: IntentGatewayPlannedStep[],
  synthesizedSteps: IntentGatewayPlannedStep[],
): boolean {
  if (parsedSteps.length === 0 || synthesizedSteps.length < 2) {
    return false;
  }
  const synthesizedRequired = synthesizedSteps.filter((step) => step.required !== false);
  const parsedRequired = parsedSteps.filter((step) => step.required !== false);
  const synthesizedEvidenceSteps = synthesizedRequired.filter((step) => step.kind !== 'answer');
  const parsedEvidenceSteps = parsedRequired.filter((step) => step.kind !== 'answer');
  const parsedHasAnswer = parsedRequired.some((step) => step.kind === 'answer');
  if (
    parsedHasAnswer
    && synthesizedEvidenceSteps.length >= 2
    && synthesizedEvidenceSteps.length > parsedEvidenceSteps.length
  ) {
    return true;
  }
  if (hasExplicitToolBackedAnswerPlan(parsedRequired)) {
    return false;
  }
  const synthesizedHasWrite = synthesizedRequired.some((step) => step.kind === 'write'
    || step.expectedToolCategories?.includes('write'));
  if (!synthesizedHasWrite) {
    return false;
  }
  const parsedHasWrite = parsedRequired.some((step) => step.kind === 'write'
    || step.expectedToolCategories?.includes('write'));
  if (!parsedHasWrite) {
    return true;
  }
  return parsedRequired.length < synthesizedRequired.length;
}

function hasExplicitToolBackedAnswerPlan(steps: IntentGatewayPlannedStep[]): boolean {
  const hasEvidenceStep = steps.some((step) => (
    step.kind !== 'answer'
    && (step.expectedToolCategories?.some(isToolBackedEvidenceCategory) ?? false)
  ));
  const hasAnswerStep = steps.some((step) => step.kind === 'answer');
  return hasEvidenceStep && hasAnswerStep;
}

function normalizePlannedStepsForDecision(
  steps: IntentGatewayPlannedStep[],
  decision: {
    route: IntentGatewayDecision['route'];
    operation: IntentGatewayDecision['operation'];
    personalItemType?: IntentGatewayDecision['entities']['personalItemType'];
    configuredSearchSources?: IntentGatewayRepairContext['configuredSearchSources'];
  },
): IntentGatewayPlannedStep[] {
  if (
    !isAutomationCatalogReadDecision(decision)
    && !isPersonalAssistantReadDecision(decision)
    && !isMemoryReadDecision(decision)
    && !isWebReadDecision(decision)
    && !isToolBackedReadAnswerDecision(decision)
  ) {
    return steps;
  }
  return steps.map((step) => {
    if (
      isToolBackedReadAnswerDecision(decision)
      && step.kind === 'write'
      && hasOnlyGenericAnswerCategories(step.expectedToolCategories)
    ) {
      const { expectedToolCategories: _expectedToolCategories, ...rest } = step;
      return {
        ...rest,
        kind: 'answer' as const,
      };
    }
    if (
      isMemoryReadDecision(decision)
      && (step.kind === 'search' || step.kind === 'read')
      && hasOnlyGenericReadCategories(step.expectedToolCategories)
    ) {
      return {
        ...step,
        kind: 'read' as const,
        expectedToolCategories: ['memory_search', 'memory_recall'],
      };
    }
    if (
      isWebReadDecision(decision)
      && (step.kind === 'search' || step.kind === 'read')
      && hasOnlyGenericReadCategories(step.expectedToolCategories)
    ) {
      return {
        ...step,
        expectedToolCategories: step.kind === 'search'
          ? ['web_search', 'browser']
          : ['web_fetch', 'browser'],
      };
    }
    if (
      isAutomationCatalogReadDecision(decision)
      && (step.kind === 'search' || step.kind === 'read')
      && hasOnlyGenericReadCategories(step.expectedToolCategories)
    ) {
      return {
        ...step,
        kind: 'read' as const,
        expectedToolCategories: ['automation_list'],
      };
    }
    if (
      isPersonalAssistantReadDecision(decision)
      && (step.kind === 'search' || step.kind === 'read')
      && hasOnlyGenericReadCategories(step.expectedToolCategories)
    ) {
      const expectedToolCategories = inferSecondBrainReadToolCategories(decision.personalItemType);
      return {
        ...step,
        kind: 'read' as const,
        ...(expectedToolCategories.length > 0 ? { expectedToolCategories } : {}),
      };
    }
    return step;
  });
}

function isAutomationCatalogReadDecision(decision: {
  route: IntentGatewayDecision['route'];
  operation: IntentGatewayDecision['operation'];
}): boolean {
  return decision.route === 'automation_control'
    && (
      decision.operation === 'read'
      || decision.operation === 'inspect'
      || decision.operation === 'search'
      || decision.operation === 'navigate'
    );
}

function isPersonalAssistantReadDecision(decision: {
  route: IntentGatewayDecision['route'];
  operation: IntentGatewayDecision['operation'];
}): boolean {
  return decision.route === 'personal_assistant_task'
    && (
      decision.operation === 'read'
      || decision.operation === 'inspect'
      || decision.operation === 'search'
      || decision.operation === 'navigate'
    );
}

function isMemoryReadDecision(decision: {
  route: IntentGatewayDecision['route'];
  operation: IntentGatewayDecision['operation'];
}): boolean {
  return decision.route === 'memory_task'
    && (
      decision.operation === 'read'
      || decision.operation === 'inspect'
      || decision.operation === 'search'
      || decision.operation === 'navigate'
    );
}

function isWebReadDecision(decision: {
  route: IntentGatewayDecision['route'];
  operation: IntentGatewayDecision['operation'];
}): boolean {
  return decision.route === 'browser_task'
    && (
      decision.operation === 'read'
      || decision.operation === 'inspect'
      || decision.operation === 'search'
      || decision.operation === 'navigate'
    );
}

function isToolBackedReadAnswerDecision(decision: {
  route: IntentGatewayDecision['route'];
  operation: IntentGatewayDecision['operation'];
}): boolean {
  return supportsToolBackedAnswerPlan(decision.route)
    && (
      decision.operation === 'read'
      || decision.operation === 'inspect'
      || decision.operation === 'search'
      || decision.operation === 'navigate'
    );
}

function hasOnlyGenericAnswerCategories(categories: string[] | undefined): boolean {
  return !categories?.length || categories.every((category) => category === 'write' || category === 'answer');
}

function hasOnlyGenericReadCategories(categories: string[] | undefined): boolean {
  return !categories?.length || categories.every((category) => (
    category === 'search'
    || category === 'read'
  ));
}

function requiresToolBackedAnswerPlan(
  route: IntentGatewayDecision['route'],
  steps: IntentGatewayPlannedStep[],
): boolean {
  if (!supportsToolBackedAnswerPlan(route)) {
    return false;
  }
  const requiredSteps = steps.filter((step) => step.required !== false);
  const hasToolEvidenceStep = requiredSteps.some((step) => (
    step.kind !== 'answer'
    && (step.expectedToolCategories?.some(isToolBackedEvidenceCategory) ?? false)
  ));
  const hasAnswerStep = requiredSteps.some((step) => step.kind === 'answer');
  return hasToolEvidenceStep && hasAnswerStep;
}

function planRequiresRepoGrounding(steps: IntentGatewayPlannedStep[]): boolean {
  return steps
    .filter((step) => step.required !== false)
    .some((step) => step.expectedToolCategories?.some(isRepoEvidenceCategory) ?? false);
}

function supportsToolBackedAnswerPlan(route: IntentGatewayDecision['route']): boolean {
  return route === 'automation_control'
    || route === 'browser_task'
    || route === 'personal_assistant_task'
    || route === 'general_assistant'
    || route === 'memory_task'
    || route === 'search_task';
}

function isToolBackedEvidenceCategory(category: string): boolean {
  const normalized = category.trim();
  return isAutomationToolCategory(normalized)
    || isMemoryToolCategory(normalized)
    || isRepoEvidenceCategory(normalized)
    || isDocumentSearchEvidenceCategory(normalized)
    || isWebEvidenceCategory(normalized)
    || normalized === 'second_brain'
    || normalized.startsWith('second_brain_');
}

function buildSearchSurfaceClarification(input: {
  route: IntentGatewayDecision['route'];
  confidence: IntentGatewayDecision['confidence'];
  operation: IntentGatewayDecision['operation'];
  resolution: IntentGatewayDecision['resolution'];
  plannedSteps: IntentGatewayPlannedStep[];
  configuredSearchSources?: IntentGatewayRepairContext['configuredSearchSources'];
}): { prompt: string } | null {
  if (input.route !== 'search_task' || input.resolution !== 'ready') {
    return null;
  }
  const hasIndexedSource = input.configuredSearchSources?.some((source) => (
    source.enabled && source.indexedSearchAvailable
  )) === true;
  if (!hasIndexedSource) {
    return null;
  }
  if (hasConcreteSearchSurface(input.plannedSteps)) {
    return null;
  }
  if (input.confidence !== 'low' && input.operation !== 'unknown' && input.plannedSteps.length > 0) {
    return null;
  }
  return {
    prompt: 'Which search surface should I use: the configured document search source, the current workspace/repo files, or web search?',
  };
}

function hasConcreteSearchSurface(steps: IntentGatewayPlannedStep[]): boolean {
  return steps.some((step) => step.expectedToolCategories?.some((category) => {
    const normalized = category.trim();
    return isDocumentSearchEvidenceCategory(normalized)
      || isWebEvidenceCategory(normalized)
      || isRepoEvidenceCategory(normalized);
  }) === true);
}

function isAutomationToolCategory(category: string): boolean {
  const normalized = category.trim();
  return normalized === 'automation'
    || normalized === 'scheduled_email_automation'
    || normalized.startsWith('automation_');
}

function isMemoryToolCategory(category: string): boolean {
  const normalized = category.trim();
  return normalized === 'memory'
    || normalized === 'memory_search'
    || normalized === 'memory_recall'
    || normalized === 'memory_save';
}

function isRepoEvidenceCategory(category: string): boolean {
  const normalized = category.trim();
  return normalized === 'repo'
    || normalized === 'repository'
    || normalized === 'repo_inspect'
    || normalized === 'repo_inspection'
    || normalized === 'fs_search'
    || normalized === 'code_symbol_search'
    || normalized === 'fs_read'
    || normalized === 'fs_list';
}

function isWebEvidenceCategory(category: string): boolean {
  const normalized = category.trim();
  return normalized === 'web'
    || normalized === 'browser'
    || normalized === 'web_search'
    || normalized === 'web_fetch'
    || normalized.startsWith('browser_');
}

function isDocumentSearchEvidenceCategory(category: string): boolean {
  const normalized = category.trim();
  return normalized === 'doc_search'
    || normalized === 'doc_search_list'
    || normalized === 'doc_search_status'
    || normalized === 'document_search'
    || normalized === 'document_sources';
}

function inferSecondBrainReadToolCategories(
  personalItemType: IntentGatewayDecision['entities']['personalItemType'] | undefined,
): string[] {
  switch (personalItemType) {
    case 'note':
      return ['second_brain_note_list'];
    case 'task':
      return ['second_brain_task_list'];
    case 'calendar':
      return ['second_brain_calendar_list'];
    case 'person':
      return ['second_brain_people_list'];
    case 'library':
      return ['second_brain_library_list'];
    case 'routine':
      return ['second_brain_routine_list', 'second_brain_routine_catalog'];
    case 'brief':
      return ['second_brain_brief_list'];
    case 'overview':
      return ['second_brain_overview'];
    case 'unknown':
    case undefined:
      return [
        'second_brain_overview',
        'second_brain_note_list',
        'second_brain_task_list',
        'second_brain_calendar_list',
        'second_brain_routine_list',
      ];
  }
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
    .replace(/,\s+(?=(?:and\s+)?(?:search|find|look\s*up|browse|grep|scan|trace|locate|read|open|inspect|review|check|create|write|remember|save\s+to\s+memory)\b)/gi, '\n')
    .replace(/\n+/g, '\n');
  const rawClauses = normalized
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'])|\n+/)
    .map((value) => collapseIntentGatewayWhitespace(value).replace(/^(?:and|then)\s+/i, ''))
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
  if (/\b(?:remember|save to memory|store in memory|save (?:a |the )?(?:global |project )?memory)\b/.test(normalized)) {
    return 'memory_save';
  }
  const searchIndex = firstPatternIndex(normalized, /\b(?:search|find|grep|scan|trace|locate)\b/);
  const readIndex = firstPatternIndex(normalized, /\b(?:read|open|inspect|review|check|look at)\b/);
  const writeIndex = firstPatternIndex(normalized, /\b(?:write|create|update|edit|patch|modify|append|delete|remove|touch|save (?:a |the )?(?:file|summary|report|note))\b/);
  const firstEvidenceIndex = [searchIndex, readIndex]
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0] ?? -1;
  if (firstEvidenceIndex >= 0 && (writeIndex < 0 || firstEvidenceIndex < writeIndex)) {
    return searchIndex >= 0 && (readIndex < 0 || searchIndex <= readIndex) ? 'search' : 'read';
  }
  if (writeIndex >= 0) {
    return 'write';
  }
  if (searchIndex >= 0) {
    return 'search';
  }
  if (readIndex >= 0) {
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

function firstPatternIndex(value: string, pattern: RegExp): number {
  const match = pattern.exec(value);
  return match?.index ?? -1;
}

function buildSynthesizedExpectedToolCategories(
  kind: IntentGatewayPlannedStep['kind'],
  summary?: string,
): Partial<IntentGatewayPlannedStep> {
  const evidenceCategories = inferSynthesizedEvidenceToolCategories(kind, summary);
  if (evidenceCategories.length > 0) {
    return { expectedToolCategories: evidenceCategories };
  }
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

function inferSynthesizedEvidenceToolCategories(
  kind: IntentGatewayPlannedStep['kind'],
  summary: string | undefined,
): string[] {
  if (kind !== 'search' && kind !== 'read') {
    return [];
  }
  const normalized = summary?.trim().toLowerCase() ?? '';
  if (!normalized) {
    return [];
  }
  const categories: string[] = [];
  if (/\b(?:memory|remembered|saved marker)\b/i.test(normalized)) {
    categories.push('memory');
  }
  if (/\b(?:repo|repository|workspace|codebase|source code|local code)\b/i.test(normalized)) {
    categories.push('repo_inspect');
  }
  if (/\bhttps?:\/\/|\b(?:web|internet|online|website|page title)\b/i.test(normalized)) {
    categories.push(...(kind === 'search'
      ? ['web_search', 'browser']
      : ['web_fetch', 'browser']));
  }
  if (/\b(?:automation|automations|workflow|workflows|routine|routines)\b/i.test(normalized)) {
    categories.push('automation_list');
  }
  const mentionsProviderConnector = /\b(?:google|gmail|gws|workspace|microsoft|m365|outlook)\b/i.test(normalized);
  if (/\b(?:vercel)\b/i.test(normalized)) {
    categories.push('vercel_status');
  }
  if (/\b(?:whm|c[\s-]?panel|cpanel)\b/i.test(normalized)) {
    categories.push('whm_status');
  }
  if (/\b(?:gmail|google|gws|google workspace)\b/i.test(normalized)) {
    categories.push('gws_status');
  }
  if (/\b(?:microsoft|m365|outlook)\b/i.test(normalized)) {
    categories.push('m365_status');
  }
  if (
    /\b(?:second brain|appointment|reminder|task list|notes?|contacts?|library)\b/i.test(normalized)
    || (!mentionsProviderConnector && /\bcalendar\b/i.test(normalized))
  ) {
    categories.push('second_brain');
  }
  return [...new Set(categories)];
}
