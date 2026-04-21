import {
  extractExplicitRepoFilePath,
  extractCodingWorkspaceTarget,
  extractExplicitRemoteExecCommand,
  inferExplicitFilesystemTaskOperation,
  inferExplicitCodingBackendRequest,
  inferExplicitCodingTaskOperation,
  isExplicitRemoteSandboxTaskRequest,
  resolveExplicitRemoteProfileId,
} from './entity-resolvers/coding.js';
import {
  inferSecondBrainOperation,
  inferSecondBrainPersonalItemType,
  isExplicitSecondBrainEntityRequest,
  isExplicitSecondBrainRoutineRequest,
} from './entity-resolvers/personal-assistant.js';
import {
  inferProviderConfigOperation,
  isExplicitProviderConfigRequest,
} from './entity-resolvers/provider-config.js';
import {
  extractExplicitAutomationOutputName,
  extractExplicitAutomationName,
  inferAutomationControlOperation,
  inferAutomationEnabledState,
  inferAutomationOutputOperation,
  isExplicitAutomationControlRequest,
  isExplicitAutomationOutputRequest,
} from './entity-resolvers/automation.js';
import { normalizeConfidence, normalizeOperation } from './normalization.js';
import {
  isExplicitComplexPlanningRequest,
  isExplicitRepoPlanningRequest,
  looksLikeStandaloneGreetingTurn,
} from './request-patterns.js';
import { collapseIntentGatewayWhitespace } from './text.js';
import type { IntentGatewayDecision, IntentGatewayRepairContext } from './types.js';

type NormalizeIntentGatewayDecisionFn = (
  parsed: Record<string, unknown>,
  repairContext?: IntentGatewayRepairContext,
  options?: {
    classifierSource?: import('./types.js').IntentGatewayProvenanceSource;
  },
) => IntentGatewayDecision;

export function repairUnavailableIntentGatewayDecision(
  repairContext: IntentGatewayRepairContext | undefined,
  parsed: Record<string, unknown> | undefined,
  normalizeIntentGatewayDecision: NormalizeIntentGatewayDecisionFn,
): IntentGatewayDecision | null {
  const rawSourceContent = collapseIntentGatewayWhitespace(repairContext?.sourceContent ?? '');
  const sourceContent = rawSourceContent.toLowerCase();
  if (!sourceContent) return null;
  if (isExplicitComplexPlanningRequest(rawSourceContent)) {
    return normalizeIntentGatewayDecision({
      ...(parsed ?? {}),
      route: 'complex_planning_task',
      operation: 'run',
      confidence: normalizeConfidence(parsed?.confidence) ?? 'medium',
      summary: typeof parsed?.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim()
        : 'Recovered explicit complex-planning request after an unstructured gateway response.',
    }, repairContext, { classifierSource: 'repair.unstructured' });
  }
  if (looksLikeStandaloneGreetingTurn(rawSourceContent)) {
    return normalizeIntentGatewayDecision({
      ...(parsed ?? {}),
      route: 'general_assistant',
      operation: 'inspect',
      confidence: normalizeConfidence(parsed?.confidence) ?? 'low',
      summary: typeof parsed?.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim()
        : 'Recovered a standalone greeting after an unstructured gateway response.',
      executionClass: 'direct_assistant',
      preferredTier: 'external',
      requiresRepoGrounding: false,
      requiresToolSynthesis: false,
      expectedContextPressure: 'low',
      preferredAnswerPath: 'direct',
      simpleVsComplex: 'simple',
    }, repairContext, { classifierSource: 'repair.unstructured' });
  }
  if (isExplicitRepoPlanningRequest(rawSourceContent)) {
    return normalizeIntentGatewayDecision({
      ...(parsed ?? {}),
      route: 'coding_task',
      operation: 'inspect',
      confidence: normalizeConfidence(parsed?.confidence) ?? 'low',
      summary: typeof parsed?.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim()
        : 'Recovered repo-scoped implementation-planning intent after an unstructured gateway response.',
    }, repairContext, { classifierSource: 'repair.unstructured' });
  }
  const inferredProviderConfigDecision = inferExplicitProviderConfigDecision(
    repairContext,
    parsed,
    normalizeIntentGatewayDecision,
  );
  if (inferredProviderConfigDecision) {
    return inferredProviderConfigDecision;
  }
  const inferredAutomationOutputDecision = inferExplicitAutomationOutputDecision(
    repairContext,
    parsed,
    normalizeIntentGatewayDecision,
  );
  if (inferredAutomationOutputDecision) {
    return inferredAutomationOutputDecision;
  }
  const inferredAutomationControlDecision = inferExplicitAutomationControlDecision(
    repairContext,
    parsed,
    normalizeIntentGatewayDecision,
  );
  if (inferredAutomationControlDecision) {
    return inferredAutomationControlDecision;
  }
  const parsedOperation = normalizeOperation(parsed?.operation);
  const inferredRemoteExecCommand = extractExplicitRemoteExecCommand(
    rawSourceContent,
    sourceContent,
    parsedOperation === 'unknown' ? 'run' : parsedOperation,
  );
  if (inferredRemoteExecCommand || isExplicitRemoteSandboxTaskRequest(rawSourceContent, sourceContent)) {
    const resolvedProfileId = resolveExplicitRemoteProfileId(rawSourceContent);
    return normalizeIntentGatewayDecision({
      ...(parsed ?? {}),
      route: 'coding_task',
      operation: 'run',
      confidence: normalizeConfidence(parsed?.confidence) ?? 'low',
      summary: typeof parsed?.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim()
        : 'Recovered explicit remote-sandbox coding intent after an unstructured gateway response.',
      ...(inferredRemoteExecCommand ? { command: inferredRemoteExecCommand } : {}),
      codingRemoteExecRequested: true,
      ...(resolvedProfileId ? { profileId: resolvedProfileId } : {}),
      ...(extractCodingWorkspaceTarget(rawSourceContent)
        ? { sessionTarget: extractCodingWorkspaceTarget(rawSourceContent) }
        : {}),
    }, repairContext, { classifierSource: 'repair.unstructured' });
  }
  const inferredCodingBackendRequest = inferExplicitCodingBackendRequest(
    rawSourceContent,
    sourceContent,
    parsedOperation,
  );
  if (inferredCodingBackendRequest) {
    return normalizeIntentGatewayDecision({
      ...(parsed ?? {}),
      route: 'coding_task',
      operation: inferredCodingBackendRequest.operation,
      confidence: normalizeConfidence(parsed?.confidence) ?? 'low',
      summary: typeof parsed?.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim()
        : 'Recovered coding-backend intent from an explicit backend workspace request after an unstructured gateway response.',
      codingBackend: inferredCodingBackendRequest.codingBackend,
      codingBackendRequested: true,
      ...(inferredCodingBackendRequest.sessionTarget
        ? { sessionTarget: inferredCodingBackendRequest.sessionTarget }
        : {}),
    }, repairContext, { classifierSource: 'repair.unstructured' });
  }
  const inferredFilesystemOperation = inferExplicitFilesystemTaskOperation(sourceContent, parsedOperation);
  if (inferredFilesystemOperation) {
    return normalizeIntentGatewayDecision({
      ...(parsed ?? {}),
      route: 'filesystem_task',
      operation: inferredFilesystemOperation,
      confidence: normalizeConfidence(parsed?.confidence) ?? 'low',
      summary: typeof parsed?.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim()
        : 'Recovered filesystem intent from an explicit workspace or path request after an unstructured gateway response.',
      ...(extractExplicitRepoFilePath(rawSourceContent)
        ? { path: extractExplicitRepoFilePath(rawSourceContent) }
        : {}),
    }, repairContext, { classifierSource: 'repair.unstructured' });
  }
  const inferredSecondBrainDecision = inferExplicitSecondBrainDecision(
    repairContext,
    parsed,
    normalizeIntentGatewayDecision,
  );
  if (inferredSecondBrainDecision) {
    return inferredSecondBrainDecision;
  }
  const inferredCodingOperation = inferExplicitCodingTaskOperation(sourceContent, parsedOperation);
  if (!inferredCodingOperation) return null;
  return normalizeIntentGatewayDecision({
    ...(parsed ?? {}),
    route: 'coding_task',
    operation: inferredCodingOperation,
    confidence: normalizeConfidence(parsed?.confidence) ?? 'low',
    summary: typeof parsed?.summary === 'string' && parsed.summary.trim()
      ? parsed.summary.trim()
      : 'Recovered coding-task intent from explicit repo file references after an unstructured gateway response.',
  }, repairContext, { classifierSource: 'repair.unstructured' });
}

function inferExplicitSecondBrainDecision(
  repairContext: IntentGatewayRepairContext | undefined,
  parsed: Record<string, unknown> | undefined,
  normalizeIntentGatewayDecision: NormalizeIntentGatewayDecisionFn,
): IntentGatewayDecision | null {
  const operation = inferSecondBrainOperation(
    repairContext?.sourceContent,
    'personal_assistant_task',
    normalizeOperation(parsed?.operation) ?? 'unknown',
  );
  if (!operation || operation === 'unknown') {
    return null;
  }
  if (
    !isExplicitSecondBrainEntityRequest(repairContext?.sourceContent, operation)
    && !isExplicitSecondBrainRoutineRequest(repairContext?.sourceContent, operation)
  ) {
    return null;
  }
  const personalItemType = inferSecondBrainPersonalItemType(
    repairContext,
    'personal_assistant_task',
    operation,
  );
  if (!personalItemType || personalItemType === 'unknown') {
    return null;
  }
  return normalizeIntentGatewayDecision({
    ...(parsed ?? {}),
    route: 'personal_assistant_task',
    operation,
    personalItemType,
    confidence: normalizeConfidence(parsed?.confidence) ?? 'low',
    summary: typeof parsed?.summary === 'string' && parsed.summary.trim()
      ? parsed.summary.trim()
      : 'Recovered Second Brain intent from an unstructured gateway response.',
  }, repairContext, { classifierSource: 'repair.unstructured' });
}

function inferExplicitProviderConfigDecision(
  repairContext: IntentGatewayRepairContext | undefined,
  parsed: Record<string, unknown> | undefined,
  normalizeIntentGatewayDecision: NormalizeIntentGatewayDecisionFn,
): IntentGatewayDecision | null {
  const rawSourceContent = collapseIntentGatewayWhitespace(repairContext?.sourceContent ?? '');
  if (!isExplicitProviderConfigRequest(rawSourceContent)) return null;
  const parsedOperation = normalizeOperation(parsed?.operation);
  return normalizeIntentGatewayDecision({
    ...(parsed ?? {}),
    route: 'general_assistant',
    operation: inferProviderConfigOperation(rawSourceContent, parsedOperation),
    confidence: normalizeConfidence(parsed?.confidence) ?? 'low',
    summary: typeof parsed?.summary === 'string' && parsed.summary.trim()
      ? parsed.summary.trim()
      : 'Recovered an AI provider configuration request after an unstructured gateway response.',
    uiSurface: 'config',
    executionClass: 'provider_crud',
    preferredTier: 'external',
    requiresRepoGrounding: false,
    requiresToolSynthesis: true,
    expectedContextPressure: 'medium',
    preferredAnswerPath: 'tool_loop',
    simpleVsComplex: 'complex',
  }, repairContext, { classifierSource: 'repair.unstructured' });
}

function inferExplicitAutomationControlDecision(
  repairContext: IntentGatewayRepairContext | undefined,
  parsed: Record<string, unknown> | undefined,
  normalizeIntentGatewayDecision: NormalizeIntentGatewayDecisionFn,
): IntentGatewayDecision | null {
  const rawSourceContent = collapseIntentGatewayWhitespace(repairContext?.sourceContent ?? '');
  if (!isExplicitAutomationControlRequest(rawSourceContent)) return null;
  const operation = inferAutomationControlOperation(
    rawSourceContent,
    normalizeOperation(parsed?.operation),
  );
  if (!operation || operation === 'unknown') return null;
  return normalizeIntentGatewayDecision({
    ...(parsed ?? {}),
    route: 'automation_control',
    operation,
    ...(extractExplicitAutomationName(rawSourceContent)
      ? { automationName: extractExplicitAutomationName(rawSourceContent) }
      : {}),
    ...(typeof inferAutomationEnabledState(rawSourceContent) === 'boolean'
      ? { enabled: inferAutomationEnabledState(rawSourceContent) }
      : {}),
    confidence: normalizeConfidence(parsed?.confidence) ?? 'low',
    summary: typeof parsed?.summary === 'string' && parsed.summary.trim()
      ? parsed.summary.trim()
      : 'Recovered an automation-control request after an unstructured gateway response.',
  }, repairContext, { classifierSource: 'repair.unstructured' });
}

function inferExplicitAutomationOutputDecision(
  repairContext: IntentGatewayRepairContext | undefined,
  parsed: Record<string, unknown> | undefined,
  normalizeIntentGatewayDecision: NormalizeIntentGatewayDecisionFn,
): IntentGatewayDecision | null {
  const rawSourceContent = collapseIntentGatewayWhitespace(repairContext?.sourceContent ?? '');
  if (!isExplicitAutomationOutputRequest(rawSourceContent)) return null;
  const operation = inferAutomationOutputOperation(
    rawSourceContent,
    normalizeOperation(parsed?.operation),
  );
  if (!operation || operation === 'unknown') return null;
  return normalizeIntentGatewayDecision({
    ...(parsed ?? {}),
    route: 'automation_output_task',
    operation,
    ...(extractExplicitAutomationOutputName(rawSourceContent)
      ? { automationName: extractExplicitAutomationOutputName(rawSourceContent) }
      : {}),
    confidence: normalizeConfidence(parsed?.confidence) ?? 'low',
    summary: typeof parsed?.summary === 'string' && parsed.summary.trim()
      ? parsed.summary.trim()
      : 'Recovered an automation-output analysis request after an unstructured gateway response.',
  }, repairContext, { classifierSource: 'repair.unstructured' });
}
