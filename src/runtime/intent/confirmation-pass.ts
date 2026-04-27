import type { ChatMessage, ChatResponse } from '../../llm/types.js';
import { deriveIntentRouteClarification } from './intent-route-clarification.js';
import {
  buildRawResponsePreview,
  parseIntentGatewayDecision,
  parseStructuredContent,
} from './structured-recovery.js';
import { collapseIntentGatewayWhitespace } from './text.js';
import {
  buildIntentGatewayContextSections,
} from './route-classifier.js';
import {
  hasConcreteToolEvidenceCategory,
  hasRequiredReadWritePlan,
} from './planned-steps.js';
import {
  findExplicitBuiltinToolName,
  INTENT_GATEWAY_CAPABILITY_INVENTORY_PROMPT_LINES,
  resolveRouteForExplicitToolName,
} from './capability-inventory.js';
import {
  isExplicitAutomationAuthoringRequest,
  isExplicitAutomationControlRequest,
  isExplicitAutomationOutputRequest,
} from './entity-resolvers/automation.js';
import {
  isExplicitRemoteSandboxTaskRequest,
} from './entity-resolvers/coding.js';
import {
  isExplicitProviderConfigRequest,
} from './entity-resolvers/provider-config.js';
import {
  isExplicitCodingExecutionRequest,
  isExplicitCodingSessionControlRequest,
  isExplicitRepoInspectionRequest,
  isExplicitRepoPlanningRequest,
  isExplicitWorkspaceScopedRepoWorkRequest,
} from './request-patterns.js';
import type {
  IntentGatewayChatFn,
  IntentGatewayDecision,
  IntentGatewayInput,
  IntentGatewayRecord,
  IntentGatewayRoute,
} from './types.js';

const CONFIRMATION_AUTOMATION_CONTROL_OPERATIONS = new Set([
  'delete',
  'toggle',
  'run',
  'inspect',
  'clone',
  'update',
]);

const INTENT_GATEWAY_CONFIRMATION_SYSTEM_PROMPT = [
  'You are Guardian\'s intent gateway confirmation pass.',
  'A previous pass already returned a structured routing decision, but runtime detected low confidence or capability-surface ambiguity.',
  'Re-check the original request against the candidate routes and capability ownership hints.',
  'If the previous route is correct, keep it.',
  'If it is wrong, return the corrected route, operation, workload metadata, and entities.',
  'For tool-plan coverage checks, compare the original request with the prior planned_steps. If the prior plan omits a requested capability domain or action, return corrected planned_steps that cover every required action before the final answer.',
  'If the original request requires external web research plus repo comparison, return concrete planned_steps with expectedToolCategories=["web_search"] for the external search step, expectedToolCategories=["repo_inspect"] for the repo evidence step, and an answer step depending on both; keep the route general_assistant unless the request only asks for web search.',
  'If the original request asks for both existing Automations and Second Brain routines, use route=general_assistant with separate required read planned_steps for expectedToolCategories=["automation_list"] and expectedToolCategories=["second_brain_routine_list","second_brain_routine_catalog"], followed by an answer step depending on both.',
  'For mutation contract checks, only keep filesystem_task or coding_task with write planned_steps when the original request explicitly requires a filesystem, code, or provider-object mutation.',
  'Requests to reveal, print, extract, dump, or exfiltrate raw API keys, bearer tokens, Telegram bot tokens, provider credentials, environment secrets, Guardian config secrets, credential-store values, or files under .guardianagent are security_task refusal/analysis turns, not filesystem_task or provider inventory, even when the user names local paths, config files, or provider API keys.',
  'For raw-secret disclosure requests, prefer executionClass=security_analysis, preferredTier=external, requiresRepoGrounding=false, requiresToolSynthesis=false, expectedContextPressure=low, simpleVsComplex=simple, and preferredAnswerPath=direct unless the user asks for a redacted audit or structural configuration review.',
  'A final comparison, explanation, recommendation, summary, or report delivered in chat is an answer step, not a write step, unless the request names a concrete saved artifact, file path, or object to create/update.',
  'If the request is still genuinely ambiguous between top-level routes, do not guess. Return resolution=needs_clarification, missingFields=["intent_route"], lower confidence, and a short clarification question in summary.',
  'Skill names are downstream execution aids. Route the underlying task, not the skill label itself.',
  ...INTENT_GATEWAY_CAPABILITY_INVENTORY_PROMPT_LINES,
  'Return exactly one JSON object and do not explain anything outside that object.',
].join(' ');

type ConfirmationCandidateRoute = Exclude<IntentGatewayRoute, 'unknown'>;

export async function confirmIntentGatewayDecisionIfNeeded(
  input: IntentGatewayInput,
  record: IntentGatewayRecord,
  chat: IntentGatewayChatFn,
): Promise<IntentGatewayRecord> {
  const confirmation = deriveIntentGatewayConfirmationRequest(input, record);
  if (!confirmation) {
    return record;
  }

  const startedAt = Date.now();
  const priorStructuredDecision = readPriorStructuredDecision(record);
  try {
    let response = await chat(buildIntentGatewayConfirmationMessages(input, record, confirmation), {
      maxTokens: 520,
      temperature: 0,
      responseFormat: { type: 'json_object' },
    });
    let parsed = parseIntentGatewayDecision(response, {
      sourceContent: input.content,
      pendingAction: input.pendingAction,
      continuity: input.continuity,
    }, {
      mode: 'confirmation',
    });
    if (parsed.available && needsConcreteToolPlanConfirmationRetry(confirmation, parsed.decision)) {
      const retryResponse = await chat(buildIntentGatewayConfirmationRetryMessages(input, record, confirmation, response), {
        maxTokens: 640,
        temperature: 0,
        responseFormat: { type: 'json_object' },
      });
      const retryParsed = parseIntentGatewayDecision(retryResponse, {
        sourceContent: input.content,
        pendingAction: input.pendingAction,
        continuity: input.continuity,
      }, {
        mode: 'confirmation',
      });
      if (retryParsed.available) {
        response = retryResponse;
        parsed = retryParsed;
      }
    }
    if (!parsed.available || !shouldAdoptConfirmationDecision(record, parsed.decision, priorStructuredDecision, confirmation)) {
      return record;
    }
    const rawResponsePreview = buildRawResponsePreview(response);
    return {
      mode: 'confirmation',
      available: true,
      model: response.model || 'unknown',
      latencyMs: Math.max(0, Date.now() - startedAt),
      ...(record.promptProfile ? { promptProfile: record.promptProfile } : {}),
      ...(rawResponsePreview ? { rawResponsePreview } : {}),
      decision: parsed.decision,
    };
  } catch {
    return record;
  }
}

function needsConcreteToolPlanConfirmationRetry(
  confirmation: { reason: string },
  decision: IntentGatewayDecision,
): boolean {
  if (!confirmation.reason.split(',').map((reason) => reason.trim()).includes('tool_plan_coverage_check')) {
    return false;
  }
  const requiredEvidenceSteps = (decision.plannedSteps ?? [])
    .filter((step) => step.required !== false && step.kind !== 'answer');
  if (requiredEvidenceSteps.length === 0) {
    return true;
  }
  return requiredEvidenceSteps.some((step) => !hasConcreteToolEvidenceCategory(step.expectedToolCategories));
}

function deriveIntentGatewayConfirmationRequest(
  input: IntentGatewayInput,
  record: IntentGatewayRecord,
): { reason: string; candidateRoutes: ConfirmationCandidateRoute[]; explicitToolName?: string } | null {
  const decision = record.decision;
  const priorStructuredDecision = readPriorStructuredDecision(record);
  const rawRequest = input.content.trim();
  const normalizedRequest = collapseIntentGatewayWhitespace(rawRequest);
  const normalizedLower = normalizedRequest.toLowerCase();
  const candidateRoutes = new Set<ConfirmationCandidateRoute>();
  const reasons: string[] = [];

  const clarification = deriveIntentRouteClarification({
    content: rawRequest,
    decision,
    mode: record.mode,
  });
  if (clarification) {
    for (const route of clarification.candidateRoutes) {
      addCandidateRoute(candidateRoutes, route);
    }
    reasons.push('top_level_route_ambiguity');
  }

  const explicitToolName = findExplicitBuiltinToolName(rawRequest);
  const explicitToolRoute = resolveRouteForExplicitToolName(explicitToolName);
  if (explicitToolRoute) {
    addCandidateRoute(candidateRoutes, explicitToolRoute);
    if (explicitToolRoute !== decision.route) {
      reasons.push('explicit_tool_route_mismatch');
    }
  }

  if (isExplicitAutomationAuthoringRequest(rawRequest)) {
    candidateRoutes.add('automation_authoring');
  }
  if (isExplicitAutomationControlRequest(rawRequest)
    || (decision.route === 'ui_control'
      && decision.entities.uiSurface === 'automations'
      && CONFIRMATION_AUTOMATION_CONTROL_OPERATIONS.has(decision.operation))) {
    candidateRoutes.add('automation_control');
  }
  if (isExplicitAutomationOutputRequest(rawRequest)) {
    candidateRoutes.add('automation_output_task');
  }

  if (isExplicitProviderConfigRequest(rawRequest)) {
    candidateRoutes.add('general_assistant');
  }

  if (
    isExplicitCodingExecutionRequest(rawRequest)
    || isExplicitRepoInspectionRequest(rawRequest)
    || isExplicitRepoPlanningRequest(rawRequest)
    || isExplicitWorkspaceScopedRepoWorkRequest(rawRequest)
    || isExplicitRemoteSandboxTaskRequest(rawRequest, normalizedLower)
  ) {
    candidateRoutes.add('coding_task');
  }

  if (isExplicitCodingSessionControlRequest(rawRequest)) {
    candidateRoutes.add('coding_session_control');
  }

  if (needsToolPlanCoverageConfirmation(decision)) {
    addCandidateRoute(candidateRoutes, decision.route);
    addCandidateRoute(candidateRoutes, 'general_assistant');
    if (decision.route === 'automation_control') {
      addCandidateRoute(candidateRoutes, 'personal_assistant_task');
    }
    if (decision.route === 'personal_assistant_task') {
      addCandidateRoute(candidateRoutes, 'automation_control');
    }
    reasons.push('tool_plan_coverage_check');
  }

  if (needsMutationContractConfirmation(decision)) {
    addCandidateRoute(candidateRoutes, decision.route);
    addCandidateRoute(candidateRoutes, 'general_assistant');
    if (decision.route === 'filesystem_task') {
      addCandidateRoute(candidateRoutes, 'coding_task');
    }
    reasons.push('mutation_contract_check');
  }

  const routes = [...candidateRoutes];
  if (routes.length === 0) {
    return null;
  }
  const priorRoute = typeof priorStructuredDecision?.route === 'string'
    ? priorStructuredDecision.route.trim()
    : '';
  if (decision.route !== 'unknown'
    && priorRoute
    && priorRoute !== decision.route
    && routes.includes(decision.route)) {
    reasons.push('classifier_route_mismatch');
  }
  const priorOperation = typeof priorStructuredDecision?.operation === 'string'
    ? priorStructuredDecision.operation.trim()
    : '';
  if (decision.route !== 'unknown'
    && priorOperation
    && priorOperation !== decision.operation
    && routes.includes(decision.route)) {
    reasons.push('classifier_operation_mismatch');
  }
  if (routes.length === 1 && routes[0] === decision.route && reasons.length === 0) {
    return null;
  }
  if (decision.route === 'unknown' || !routes.includes(decision.route)) {
    reasons.push('capability_owner_mismatch');
  }

  return {
    reason: [...new Set(reasons)].join(', '),
    candidateRoutes: routes,
    ...(explicitToolName ? { explicitToolName } : {}),
  };
}

function needsToolPlanCoverageConfirmation(decision: IntentGatewayDecision): boolean {
  if (decision.resolution !== 'ready' || decision.requiresToolSynthesis !== true) {
    return false;
  }
  if (
    decision.route !== 'automation_control'
    && decision.route !== 'personal_assistant_task'
    && decision.route !== 'general_assistant'
  ) {
    return false;
  }
  const requiredSteps = (decision.plannedSteps ?? []).filter((step) => step.required !== false);
  const hasEvidenceStep = requiredSteps.some((step) => step.kind !== 'answer');
  const hasAnswerStep = requiredSteps.some((step) => step.kind === 'answer' || step.kind === 'write');
  return hasEvidenceStep && hasAnswerStep;
}

function needsMutationContractConfirmation(decision: IntentGatewayDecision): boolean {
  if (decision.resolution !== 'ready' || decision.requiresToolSynthesis !== true) {
    return false;
  }
  if (decision.route !== 'filesystem_task' && decision.route !== 'coding_task') {
    return false;
  }
  if (!hasRequiredReadWritePlan(decision)) {
    return false;
  }
  const requiredWriteSteps = (decision.plannedSteps ?? [])
    .filter((step) => step.required !== false && step.kind === 'write');
  if (requiredWriteSteps.length === 0) {
    return false;
  }
  const hasStructuredFilesystemTarget = !!decision.entities.path?.trim();
  const missingFilesystemTarget = decision.route === 'filesystem_task'
    && !hasStructuredFilesystemTarget;
  const hasGenericWriteStep = requiredWriteSteps.some((step) => (
    !hasConcreteToolEvidenceCategory(step.expectedToolCategories)
  ));
  if (decision.route === 'filesystem_task' && hasStructuredFilesystemTarget) {
    return false;
  }
  return decision.confidence === 'low'
    || missingFilesystemTarget
    || hasGenericWriteStep;
}

function buildIntentGatewayConfirmationMessages(
  input: IntentGatewayInput,
  record: IntentGatewayRecord,
  confirmation: { reason: string; candidateRoutes: ConfirmationCandidateRoute[]; explicitToolName?: string },
): ChatMessage[] {
  const sections = buildIntentGatewayContextSections(input);
  const priorStructuredDecision = readPriorStructuredDecision(record);
  const canonicalDecision = serializeDecisionForPrompt(record.decision);
  return [
    {
      role: 'system',
      content: INTENT_GATEWAY_CONFIRMATION_SYSTEM_PROMPT,
    },
    {
      role: 'user',
      content: [
        `Confirmation reason: ${confirmation.reason || 'unspecified'}`,
        `Candidate routes: ${confirmation.candidateRoutes.join(', ')}`,
        ...(confirmation.explicitToolName ? [`Explicit tool name: ${confirmation.explicitToolName}`] : []),
        `Prior decision JSON: ${JSON.stringify(priorStructuredDecision ?? canonicalDecision)}`,
        `Canonical repaired decision JSON: ${JSON.stringify(canonicalDecision)}`,
        '',
        ...sections,
      ].join('\n'),
    },
  ];
}

function buildIntentGatewayConfirmationRetryMessages(
  input: IntentGatewayInput,
  record: IntentGatewayRecord,
  confirmation: { reason: string; candidateRoutes: ConfirmationCandidateRoute[]; explicitToolName?: string },
  previousResponse: ChatResponse,
): ChatMessage[] {
  return [
    ...buildIntentGatewayConfirmationMessages(input, record, confirmation),
    {
      role: 'assistant',
      content: previousResponse.content ?? '{}',
    },
    {
      role: 'user',
      content: [
        'The previous confirmation result is still structurally insufficient for a tool-plan coverage check.',
        'At least one required non-answer planned step used only generic evidence categories such as search/read/write, or no concrete tool category at all.',
        'Return the corrected JSON again with concrete expectedToolCategories for each required evidence step, using the capability inventory and the original request.',
        'For catalog/list evidence, do not use generic search/read/write categories when a concrete tool category exists.',
        'Keep mutation requests separate from answer synthesis: if the user asks for a recommendation or suggestion without creating it, use kind="answer" for that final step.',
      ].join(' '),
    },
  ];
}

function shouldAdoptConfirmationDecision(
  previousRecord: IntentGatewayRecord,
  next: IntentGatewayDecision,
  priorStructuredDecision: Record<string, unknown> | null,
  confirmation: { candidateRoutes: ConfirmationCandidateRoute[] },
): boolean {
  if (!confirmation.candidateRoutes.includes(next.route as ConfirmationCandidateRoute)) {
    return false;
  }
  if (priorStructuredDecision && doesPriorStructuredDecisionDisagree(priorStructuredDecision, next)) {
    return true;
  }
  return JSON.stringify(serializeDecisionForComparison(previousRecord.decision))
    !== JSON.stringify(serializeDecisionForComparison(next));
}

function doesPriorStructuredDecisionDisagree(
  prior: Record<string, unknown>,
  next: IntentGatewayDecision,
): boolean {
  const priorRoute = typeof prior.route === 'string' ? prior.route.trim() : '';
  if (priorRoute && priorRoute !== next.route) {
    return true;
  }
  const priorOperation = typeof prior.operation === 'string' ? prior.operation.trim() : '';
  if (priorOperation && priorOperation !== next.operation) {
    return true;
  }
  const priorResolution = typeof prior.resolution === 'string' ? prior.resolution.trim() : '';
  return !!priorResolution && priorResolution !== next.resolution;
}

function serializeDecisionForComparison(
  decision: IntentGatewayDecision,
): Record<string, unknown> {
  return {
    route: decision.route,
    confidence: decision.confidence,
    operation: decision.operation,
    summary: decision.summary,
    turnRelation: decision.turnRelation,
    resolution: decision.resolution,
    missingFields: [...decision.missingFields].sort(),
    executionClass: decision.executionClass,
    preferredTier: decision.preferredTier,
    requiresRepoGrounding: decision.requiresRepoGrounding,
    requiresToolSynthesis: decision.requiresToolSynthesis,
    requireExactFileReferences: decision.requireExactFileReferences,
    expectedContextPressure: decision.expectedContextPressure,
    preferredAnswerPath: decision.preferredAnswerPath,
    simpleVsComplex: decision.simpleVsComplex,
    plannedSteps: (decision.plannedSteps ?? []).map((step) => ({
      kind: step.kind,
      summary: step.summary,
      expectedToolCategories: step.expectedToolCategories,
      required: step.required,
      dependsOn: step.dependsOn,
    })),
    resolvedContent: decision.resolvedContent,
    entities: Object.keys(decision.entities)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = decision.entities[key as keyof typeof decision.entities];
        return acc;
      }, {}),
  };
}

function serializeDecisionForPrompt(
  decision: IntentGatewayDecision,
): Record<string, unknown> {
  return {
    route: decision.route,
    confidence: decision.confidence,
    operation: decision.operation,
    summary: decision.summary,
    turnRelation: decision.turnRelation,
    resolution: decision.resolution,
    missingFields: decision.missingFields,
    executionClass: decision.executionClass,
    preferredTier: decision.preferredTier,
    requiresRepoGrounding: decision.requiresRepoGrounding,
    requiresToolSynthesis: decision.requiresToolSynthesis,
    ...(typeof decision.requireExactFileReferences === 'boolean'
      ? { requireExactFileReferences: decision.requireExactFileReferences }
      : {}),
    expectedContextPressure: decision.expectedContextPressure,
    preferredAnswerPath: decision.preferredAnswerPath,
    ...(decision.simpleVsComplex ? { simpleVsComplex: decision.simpleVsComplex } : {}),
    ...(decision.plannedSteps?.length
      ? {
          planned_steps: decision.plannedSteps.map((step) => ({
            kind: step.kind,
            summary: step.summary,
            ...(step.expectedToolCategories ? { expectedToolCategories: step.expectedToolCategories } : {}),
            ...(typeof step.required === 'boolean' ? { required: step.required } : {}),
            ...(step.dependsOn ? { dependsOn: step.dependsOn } : {}),
          })),
        }
      : {}),
    ...(decision.resolvedContent ? { resolvedContent: decision.resolvedContent } : {}),
    ...decision.entities,
  };
}

function readPriorStructuredDecision(record: IntentGatewayRecord): Record<string, unknown> | null {
  if (record.rawStructuredDecision) {
    return { ...record.rawStructuredDecision };
  }
  if (!record.rawResponsePreview?.trim()) {
    return null;
  }
  return parseStructuredContent(record.rawResponsePreview);
}

function addCandidateRoute(
  candidateRoutes: Set<ConfirmationCandidateRoute>,
  route: IntentGatewayRoute,
): void {
  if (route !== 'unknown') {
    candidateRoutes.add(route);
  }
}
