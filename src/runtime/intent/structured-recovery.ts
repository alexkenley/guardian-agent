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
import { requestNeedsExactFileReferences } from './request-patterns.js';
import type {
  IntentGatewayDecision,
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
        decision: repaired,
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
        decision: repaired,
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
