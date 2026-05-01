import type {
  AssistantModelSelectionConfig,
  GuardianAgentConfig,
  ManagedCloudRoutingRole,
  PreferredProviderKey,
  RoutingTierMode,
} from '../config/types.js';
import {
  getManagedCloudRoleBindingsForProviderType,
  isManagedCloudProfileForProviderType,
  listConfiguredManagedCloudProviderTypes,
  listConfiguredManagedCloudProfilesForType,
  resolvePreferredManagedCloudSelection,
  resolvePreferredManagedCloudProviderType,
} from '../config/managed-cloud-routing.js';
import {
  getProviderLocality,
  getProviderTier,
  type ProviderLocality,
  type ProviderTier,
} from '../llm/provider-metadata.js';
import type {
  IntentGatewayDecision,
  IntentGatewayExpectedContextPressure,
  IntentGatewayOperation,
  IntentGatewayPreferredAnswerPath,
} from './intent-gateway.js';
import {
  hasRequiredWritePlannedStep,
  requiresSecurityEvidence,
} from './intent/planned-steps.js';
import type { RouteDecision } from './message-router.js';
import type { OrchestrationRoleDescriptor } from './orchestration-role-descriptors.js';

export type ExecutionProfileId =
  | 'local_direct'
  | 'local_tool'
  | 'managed_cloud_direct'
  | 'managed_cloud_tool'
  | 'frontier_deep';

export type ExecutionProfileToolContextMode = 'tight' | 'standard';
export type ExecutionProfileSelectionSource = 'auto' | 'request_override' | 'delegated_role';

export interface SelectedExecutionProfile {
  id: ExecutionProfileId;
  providerName: string;
  providerType: string;
  providerModel?: string;
  providerLocality: ProviderLocality;
  providerTier: ProviderTier;
  requestedTier: 'local' | 'external';
  preferredAnswerPath: IntentGatewayPreferredAnswerPath;
  expectedContextPressure: IntentGatewayExpectedContextPressure;
  contextBudget: number;
  toolContextMode: ExecutionProfileToolContextMode;
  maxAdditionalSections: number;
  maxRuntimeNotices: number;
  fallbackProviderOrder: string[];
  reason: string;
  routingMode?: RoutingTierMode;
  selectionSource?: ExecutionProfileSelectionSource;
}

export const EXECUTION_PROFILE_METADATA_KEY = '__guardian_execution_profile';

const DEFAULT_MODEL_SELECTION_POLICY: AssistantModelSelectionConfig = {
  autoPolicy: 'balanced',
  preferManagedCloudForLowPressureExternal: true,
  preferFrontierForRepoGrounded: true,
  preferFrontierForSecurity: true,
  managedCloudRouting: {
    enabled: true,
    roleBindings: {},
  },
};

const READ_LIKE_OPERATIONS = new Set<IntentGatewayOperation>([
  'inspect',
  'read',
  'search',
]);
const WORKSPACE_MUTATION_OPERATIONS = new Set<IntentGatewayOperation>([
  'create',
  'update',
  'delete',
  'save',
]);
const READ_ONLY_EVIDENCE_STEP_CATEGORIES = new Set([
  'read',
  'search',
  'repo',
  'repository',
  'repo_inspect',
  'repo_inspection',
  'fs_read',
  'fs_list',
  'fs_search',
  'code_symbol_search',
  'web',
  'web_search',
  'web_fetch',
  'browser',
  'browser_read',
  'browser_links',
  'browser_extract',
  'browser_state',
  'memory',
  'memory_task',
  'memory_search',
  'memory_recall',
  'automation',
  'automation_list',
  'second_brain',
  'second_brain_overview',
  'second_brain_brief_list',
  'second_brain_note_list',
  'second_brain_task_list',
  'second_brain_calendar_list',
  'second_brain_people_list',
  'second_brain_library_list',
  'second_brain_routine_list',
  'second_brain_routine_catalog',
]);

function normalizeModelSelectionPolicy(
  config: GuardianAgentConfig,
): AssistantModelSelectionConfig {
  return {
    ...DEFAULT_MODEL_SELECTION_POLICY,
    ...(config.assistant.tools.modelSelection ?? {}),
  };
}

function isExpectedContextPressure(value: unknown): value is IntentGatewayExpectedContextPressure {
  return value === 'low' || value === 'medium' || value === 'high';
}

function isPreferredAnswerPath(value: unknown): value is IntentGatewayPreferredAnswerPath {
  return value === 'direct' || value === 'tool_loop' || value === 'chat_synthesis';
}

function isExecutionProfileToolContextMode(value: unknown): value is ExecutionProfileToolContextMode {
  return value === 'tight' || value === 'standard';
}

function isProviderTier(value: unknown): value is ProviderTier {
  return value === 'local' || value === 'managed_cloud' || value === 'frontier';
}

function isExecutionProfileSelectionSource(value: unknown): value is ExecutionProfileSelectionSource {
  return value === 'auto' || value === 'request_override' || value === 'delegated_role';
}

function isReadLikeOperation(value: IntentGatewayOperation | undefined): boolean {
  return value ? READ_LIKE_OPERATIONS.has(value) : false;
}

function isExplicitWorkspaceMutationOperation(value: IntentGatewayOperation | undefined): boolean {
  return value ? WORKSPACE_MUTATION_OPERATIONS.has(value) : false;
}

function hasStructuredReadOnlyEvidencePlan(decision: IntentGatewayDecision): boolean {
  const requiredEvidenceSteps = (decision.plannedSteps ?? []).filter((step) => (
    step.required !== false && step.kind !== 'answer'
  ));
  if (requiredEvidenceSteps.length === 0 || hasRequiredWritePlannedStep(decision)) {
    return false;
  }
  return requiredEvidenceSteps.every((step) => {
    const expectedCategories = step.expectedToolCategories ?? [];
    const categoriesAreReadOnly = expectedCategories.length === 0
      || expectedCategories.every((category) => READ_ONLY_EVIDENCE_STEP_CATEGORIES.has(category.trim()));
    return categoriesAreReadOnly && (step.kind === 'read' || step.kind === 'search');
  });
}

function deriveDelegatedReadOperation(base: IntentGatewayDecision): IntentGatewayOperation {
  if (isReadLikeOperation(base.operation)) {
    return base.operation;
  }
  const requiredEvidenceSteps = (base.plannedSteps ?? []).filter((step) => (
    step.required !== false && step.kind !== 'answer'
  ));
  if (requiredEvidenceSteps.some((step) => step.kind === 'search')) {
    return 'search';
  }
  if (requiredEvidenceSteps.some((step) => step.kind === 'read')) {
    return 'read';
  }
  return 'inspect';
}

export function providerMatchesTier(
  llmCfg: Pick<GuardianAgentConfig['llm'][string], 'enabled' | 'provider'> | undefined,
  tier: ProviderTier,
): boolean {
  if (!llmCfg?.provider || llmCfg.enabled === false) return false;
  if (tier === 'local') {
    return getProviderLocality(llmCfg.provider) === 'local';
  }
  return getProviderTier(llmCfg.provider) === tier;
}

export function getPreferredProviderKeyForTier(tier: ProviderTier): PreferredProviderKey {
  if (tier === 'local') return 'local';
  if (tier === 'managed_cloud') return 'managedCloud';
  return 'frontier';
}

export function findProviderByTier(
  config: GuardianAgentConfig,
  tier: ProviderTier,
): string | null {
  if (tier === 'managed_cloud') {
    const preferredManagedCloud = resolvePreferredManagedCloudSelection(config);
    const preferredManagedCloudType = preferredManagedCloud.providerType;
    if (preferredManagedCloudType) {
      const bindings = getManagedCloudRoleBindingsForProviderType(config, preferredManagedCloudType);
      const general = bindings.general?.trim();
      if (general && isManagedCloudProfileForProviderType(config, general, preferredManagedCloudType)) {
        return general;
      }
      const legacyProviderName = preferredManagedCloud.legacyProviderName?.trim();
      if (legacyProviderName && providerMatchesTier(config.llm[legacyProviderName], tier)) {
        return legacyProviderName;
      }
      const preferredFamilyProviders = listConfiguredManagedCloudProfilesForType(config, preferredManagedCloudType);
      if (preferredFamilyProviders.length > 0) {
        return preferredFamilyProviders[0];
      }
    }
  }

  const preferredProviders = config.assistant.tools.preferredProviders ?? {};
  const preferredKey = getPreferredProviderKeyForTier(tier);
  const preferred = preferredProviders[preferredKey]?.trim();
  if (preferred && providerMatchesTier(config.llm[preferred], tier)) {
    return preferred;
  }

  if (tier !== 'local' && !preferred) {
    const legacyExternal = preferredProviders.external?.trim();
    if (legacyExternal && providerMatchesTier(config.llm[legacyExternal], tier)) {
      return legacyExternal;
    }
  }

  if (providerMatchesTier(config.llm[config.defaultProvider], tier)) {
    return config.defaultProvider;
  }

  const matches = Object.entries(config.llm)
    .filter(([, llmCfg]) => providerMatchesTier(llmCfg, tier))
    .map(([name]) => name)
    .sort((left, right) => left.localeCompare(right));
  return matches[0] ?? null;
}

export function findProviderByLocality(
  config: GuardianAgentConfig,
  locality: ProviderLocality,
): string | null {
  if (locality === 'local') {
    return findProviderByTier(config, 'local');
  }
  return findProviderByTier(config, 'managed_cloud')
    ?? findProviderByTier(config, 'frontier');
}

function listProvidersForTier(
  config: GuardianAgentConfig,
  tier: ProviderTier,
): string[] {
  const preferred = findProviderByTier(config, tier);
  const names = Object.entries(config.llm)
    .filter(([, llmCfg]) => providerMatchesTier(llmCfg, tier))
    .map(([name]) => name)
    .sort((left, right) => left.localeCompare(right));
  const ordered = preferred ? [preferred, ...names.filter((name) => name !== preferred)] : names;
  return [...new Set(ordered)];
}

function getManagedCloudRoutingRole(input: {
  decision: IntentGatewayDecision | null | undefined;
  preferredAnswerPath: IntentGatewayPreferredAnswerPath;
}): ManagedCloudRoutingRole {
  if (!input.decision) return 'general';
  if (
    input.decision.confidence === 'low'
    && (input.decision.route === 'unknown' || input.decision.route === 'general_assistant')
  ) {
    return 'general';
  }
  if (
    input.decision?.route === 'coding_task'
    || input.decision?.executionClass === 'repo_grounded'
    || input.decision?.requiresRepoGrounding === true
  ) {
    return 'coding';
  }
  if (input.decision.executionClass === 'direct_assistant') {
    return 'direct';
  }
  if (input.decision.confidence === 'low') {
    return input.preferredAnswerPath === 'direct' ? 'direct' : 'general';
  }
  if (input.preferredAnswerPath === 'tool_loop') {
    return 'toolLoop';
  }
  if (input.preferredAnswerPath === 'direct') {
    return 'direct';
  }
  return 'general';
}

const MANAGED_CLOUD_FAMILY_FALLBACK_ORDER = ['ollama_cloud', 'openrouter', 'nvidia'];

function inferManagedCloudRoleFromProviderName(providerName: string): ManagedCloudRoutingRole {
  const normalized = providerName.trim().toLowerCase();
  if (!normalized) return 'general';
  if (/(coding|coder|code|repo|dev|swe)/.test(normalized)) return 'coding';
  if (/(tool|tools|loop|crud|ops|agent)/.test(normalized)) return 'toolLoop';
  if (/(direct|chat|answer|fast)/.test(normalized)) return 'direct';
  return 'general';
}

function findManagedCloudProviderByHeuristic(
  config: GuardianAgentConfig,
  providerType: string | undefined,
  desiredRole: ManagedCloudRoutingRole,
): string | null {
  const managedCloudProviders = listConfiguredManagedCloudProfilesForType(config, providerType);
  const specific = managedCloudProviders.find((providerName) => inferManagedCloudRoleFromProviderName(providerName) === desiredRole);
  if (specific) return specific;
  if (desiredRole === 'general') return null;
  return managedCloudProviders.find((providerName) => inferManagedCloudRoleFromProviderName(providerName) === 'general') ?? null;
}

function getManagedCloudProviderSelection(input: {
  config: GuardianAgentConfig;
  decision: IntentGatewayDecision | null | undefined;
  preferredAnswerPath: IntentGatewayPreferredAnswerPath;
}): { providerName: string; reasonSuffix?: string } | null {
  const preferredManagedCloudType = resolvePreferredManagedCloudProviderType(input.config);
  const preferred = findProviderByTier(input.config, 'managed_cloud');
  if (!preferred) return null;

  const managedCloudRouting = input.config.assistant.tools.modelSelection?.managedCloudRouting;
  if (managedCloudRouting?.enabled === false) {
    return { providerName: preferred };
  }

  const desiredRole = getManagedCloudRoutingRole({
    decision: input.decision,
    preferredAnswerPath: input.preferredAnswerPath,
  });
  const roleBindings = preferredManagedCloudType
    ? getManagedCloudRoleBindingsForProviderType(input.config, preferredManagedCloudType)
    : {};
  const validateManagedCloudProvider = (providerName: string | undefined): string | null => {
    const trimmed = providerName?.trim();
    if (!trimmed || !preferredManagedCloudType) return null;
    return isManagedCloudProfileForProviderType(input.config, trimmed, preferredManagedCloudType) ? trimmed : null;
  };

  const specific = validateManagedCloudProvider(roleBindings?.[desiredRole]);
  if (specific) {
    return {
      providerName: specific,
      reasonSuffix: `managed-cloud role '${desiredRole}' selected provider '${specific}'`,
    };
  }

  const general = desiredRole !== 'general'
    ? validateManagedCloudProvider(roleBindings?.general)
    : null;
  if (general) {
    return {
      providerName: general,
      reasonSuffix: `managed-cloud role '${desiredRole}' fell back to general provider '${general}' in family '${preferredManagedCloudType}'`,
    };
  }

  const inferred = findManagedCloudProviderByHeuristic(input.config, preferredManagedCloudType || undefined, desiredRole);
  if (inferred) {
    const inferredRole = inferManagedCloudRoleFromProviderName(inferred);
    return {
      providerName: inferred,
      reasonSuffix: inferredRole === desiredRole
        ? `managed-cloud role '${desiredRole}' inferred provider '${inferred}' from profile name`
        : `managed-cloud role '${desiredRole}' inferred general provider '${inferred}' from profile name`,
    };
  }

  return { providerName: preferred };
}

function listManagedCloudFamilyFallbackProviders(
  config: GuardianAgentConfig,
  primaryProvider: string,
): string[] {
  const ordered: string[] = [];
  const addProvider = (providerName: string | undefined): void => {
    const trimmed = providerName?.trim();
    if (!trimmed || trimmed === primaryProvider || ordered.includes(trimmed)) return;
    if (getProviderTier(config.llm[trimmed]?.provider) !== 'managed_cloud') return;
    ordered.push(trimmed);
  };
  const configuredTypes = listConfiguredManagedCloudProviderTypes(config);
  const familyOrder = [
    ...MANAGED_CLOUD_FAMILY_FALLBACK_ORDER,
    ...configuredTypes.filter((providerType) => !MANAGED_CLOUD_FAMILY_FALLBACK_ORDER.includes(providerType)),
  ];

  for (const providerType of familyOrder) {
    const bindings = getManagedCloudRoleBindingsForProviderType(config, providerType);
    for (const role of ['general', 'direct', 'toolLoop', 'coding'] as const) {
      addProvider(bindings[role]);
    }
    for (const providerName of listConfiguredManagedCloudProfilesForType(config, providerType)) {
      addProvider(providerName);
    }
  }
  return ordered;
}

function buildFallbackTierOrder(
  primaryTier: ProviderTier,
  policy: AssistantModelSelectionConfig,
): ProviderTier[] {
  if (primaryTier === 'local') {
    return policy.autoPolicy === 'quality_first'
      ? ['frontier', 'managed_cloud', 'local']
      : ['managed_cloud', 'frontier', 'local'];
  }
  if (primaryTier === 'managed_cloud') {
    return ['frontier', 'local', 'managed_cloud'];
  }
  return ['frontier', 'managed_cloud', 'local'];
}

function buildFallbackProviderOrder(
  config: GuardianAgentConfig,
  primaryProvider: string,
  primaryTier: ProviderTier,
  policy: AssistantModelSelectionConfig,
): string[] {
  const ordered: string[] = [primaryProvider];
  if (primaryTier === 'managed_cloud') {
    for (const providerName of listManagedCloudFamilyFallbackProviders(config, primaryProvider)) {
      if (!ordered.includes(providerName)) {
        ordered.push(providerName);
      }
    }
  }
  for (const tier of buildFallbackTierOrder(primaryTier, policy)) {
    if (primaryTier === 'managed_cloud' && tier === 'managed_cloud') {
      continue;
    }
    for (const providerName of listProvidersForTier(config, tier)) {
      if (!ordered.includes(providerName)) {
        ordered.push(providerName);
      }
    }
  }
  return ordered;
}

function shouldPreferFrontier(
  decision: IntentGatewayDecision | null | undefined,
  policy: AssistantModelSelectionConfig,
): boolean {
  if (!decision) return false;
  // Direct reasoning mode uses an iterative tool loop — managed cloud is
  // adequate because the model can explore, read files, and refine its
  // answer over multiple turns. Compute the execution mode from the same
  // signals as shouldHandleDirectReasoningMode in direct-reasoning-mode.ts.
  if (wouldUseDirectReasoningMode(decision)) {
    return false;
  }
  if (
    decision.executionClass === 'security_analysis'
    && policy.preferFrontierForSecurity
    && requiresSecurityEvidence(decision)
  ) {
    return true;
  }
  if (
    decision.requiresRepoGrounding
    && policy.preferFrontierForRepoGrounded
  ) {
    if (decision.preferredAnswerPath === 'chat_synthesis') {
      return true;
    }
    if (policy.autoPolicy === 'quality_first' && decision.expectedContextPressure === 'high') {
      return true;
    }
  }
  if (
    policy.autoPolicy === 'quality_first'
    && (decision.expectedContextPressure === 'high' || decision.preferredAnswerPath === 'chat_synthesis')
  ) {
    return true;
  }
  return false;
}

/**
 * Determine whether a gateway decision would be handled by Direct Reasoning
 * Mode (iterative tool loop) rather than Delegated Orchestration (contract
 * pipeline). This mirrors shouldHandleDirectReasoningMode in
 * direct-reasoning-mode.ts, but without the tier check (tier isn't resolved
 * yet when this is called during execution profile selection).
 *
 * The key insight: direct reasoning mode is used for read-like repo-grounded
 * operations, NOT for mutations, security analysis, or complex planning.
 * These all go through the delegated pipeline where frontier preference
 * still applies.
 */
function wouldUseDirectReasoningMode(decision: IntentGatewayDecision): boolean {
  if (!decision) return false;
  const isRepoGrounded = decision.requiresRepoGrounding === true
    || decision.executionClass === 'repo_grounded';
  const isInspectLike = isReadLikeOperation(decision.operation);
  const isRepoInspectionRoute = decision.route === 'coding_task' && isInspectLike;

  if (!isInspectLike) return false;
  if (!isRepoGrounded && !isRepoInspectionRoute) return false;
  // Mutations always go through delegated orchestration.
  if (decision.operation === 'create' || decision.operation === 'update' || decision.operation === 'delete') return false;
  // Security analysis always goes through delegated orchestration
  if (decision.executionClass === 'security_analysis') return false;
  // Complex planning always goes through delegated orchestration
  if (decision.executionClass === 'tool_orchestration') return false;
  // Structured plans with required writes go through delegated graph control.
  if (hasRequiredWritePlannedStep(decision)) return false;
  return true;
}

function shouldPreferManagedCloud(
  decision: IntentGatewayDecision | null | undefined,
  policy: AssistantModelSelectionConfig,
): boolean {
  if (!decision) return false;
  if (!policy.preferManagedCloudForLowPressureExternal) return false;
  return decision.expectedContextPressure === 'low'
    && decision.preferredAnswerPath !== 'chat_synthesis'
    && !decision.requiresRepoGrounding;
}

function chooseExternalTier(input: {
  config: GuardianAgentConfig;
  decision: IntentGatewayDecision | null | undefined;
  mode: RoutingTierMode;
  policy: AssistantModelSelectionConfig;
}): { tier: ProviderTier; reason: string } | null {
  const managedCloud = findProviderByTier(input.config, 'managed_cloud');
  const frontier = findProviderByTier(input.config, 'frontier');

  if (input.mode === 'managed-cloud-only') {
    if (managedCloud) return { tier: 'managed_cloud', reason: 'forced managed-cloud routing mode' };
    if (frontier) return { tier: 'frontier', reason: 'forced managed-cloud routing mode degraded to frontier because managed cloud is unavailable' };
    return findProviderByTier(input.config, 'local')
      ? { tier: 'local', reason: 'forced managed-cloud routing mode degraded to local because no external provider is configured' }
      : null;
  }
  if (input.mode === 'frontier-only') {
    if (frontier) return { tier: 'frontier', reason: 'forced frontier routing mode' };
    if (managedCloud) return { tier: 'managed_cloud', reason: 'forced frontier routing mode degraded to managed cloud because frontier is unavailable' };
    return findProviderByTier(input.config, 'local')
      ? { tier: 'local', reason: 'forced frontier routing mode degraded to local because no external provider is configured' }
      : null;
  }

  if (frontier && shouldPreferFrontier(input.decision, input.policy)) {
    return {
      tier: 'frontier',
      reason: input.decision?.executionClass === 'security_analysis'
        ? 'frontier preferred for security analysis workload'
        : 'frontier preferred for heavier repo/synthesis workload',
    };
  }
  if (managedCloud && shouldPreferManagedCloud(input.decision, input.policy)) {
    return {
      tier: 'managed_cloud',
      reason: 'managed cloud preferred for lower-pressure external workload',
    };
  }
  if (managedCloud) {
    return { tier: 'managed_cloud', reason: 'managed cloud selected as the default external tier' };
  }
  if (frontier) {
    return { tier: 'frontier', reason: 'frontier selected because managed cloud is unavailable' };
  }
  if (findProviderByTier(input.config, 'local')) {
    return { tier: 'local', reason: 'no external provider is configured; degrading to local tier' };
  }
  return null;
}

function resolveSelectedTier(input: {
  config: GuardianAgentConfig;
  routeDecision: Pick<RouteDecision, 'tier'> | null | undefined;
  decision: IntentGatewayDecision | null | undefined;
  mode: RoutingTierMode;
  policy: AssistantModelSelectionConfig;
}): { tier: ProviderTier; requestedTier: 'local' | 'external'; reason: string } | null {
  if (input.mode === 'local-only') {
    if (findProviderByTier(input.config, 'local')) {
      return { tier: 'local', requestedTier: 'local', reason: 'forced local routing mode' };
    }
    const degraded = chooseExternalTier({
      config: input.config,
      decision: input.decision,
      mode: 'managed-cloud-only',
      policy: input.policy,
    });
    return degraded
      ? {
          tier: degraded.tier,
          requestedTier: degraded.tier === 'local' ? 'local' : 'external',
          reason: 'forced local routing mode degraded because no local provider is configured',
        }
      : null;
  }

  if (input.mode === 'managed-cloud-only' || input.mode === 'frontier-only') {
    const forced = chooseExternalTier({
      config: input.config,
      decision: input.decision,
      mode: input.mode,
      policy: input.policy,
    });
    return forced
      ? {
          tier: forced.tier,
          requestedTier: forced.tier === 'local' ? 'local' : 'external',
          reason: forced.reason,
        }
      : null;
  }

  const requestedTier = input.routeDecision?.tier === 'local' || input.routeDecision?.tier === 'external'
    ? input.routeDecision.tier
    : (input.decision?.preferredTier === 'local' || input.decision?.preferredTier === 'external'
      ? input.decision.preferredTier
      : 'local');
  if (requestedTier === 'local') {
    if (findProviderByTier(input.config, 'local')) {
      return { tier: 'local', requestedTier: 'local', reason: 'auto route selected the local tier' };
    }
    const degraded = chooseExternalTier({
      config: input.config,
      decision: input.decision,
      mode: 'managed-cloud-only',
      policy: input.policy,
    });
    return degraded
      ? {
          tier: degraded.tier,
          requestedTier: 'external',
          reason: 'auto route selected local, but no local provider is configured',
        }
      : null;
  }

  const external = chooseExternalTier({
    config: input.config,
    decision: input.decision,
    mode: input.mode,
    policy: input.policy,
  });
  return external
    ? {
        tier: external.tier,
        requestedTier: external.tier === 'local' ? 'local' : 'external',
        reason: external.reason,
      }
    : null;
}

function computeContextBudget(input: {
  baseBudget: number;
  tier: ProviderTier;
  expectedContextPressure: IntentGatewayExpectedContextPressure;
  preferredAnswerPath: IntentGatewayPreferredAnswerPath;
}): number {
  const target = input.tier === 'local'
    ? (input.preferredAnswerPath === 'direct'
      ? 18_000
      : input.expectedContextPressure === 'high'
        ? 28_000
        : 24_000)
    : input.tier === 'managed_cloud'
      ? (input.preferredAnswerPath === 'direct'
        ? 24_000
        : input.expectedContextPressure === 'high'
          ? 40_000
          : 32_000)
      : (input.expectedContextPressure === 'high'
        ? 64_000
        : input.preferredAnswerPath === 'chat_synthesis'
          ? 52_000
          : 36_000);
  return Math.max(12_000, Math.min(input.baseBudget, target));
}

function buildForcedProviderExecutionProfile(input: {
  config: GuardianAgentConfig;
  providerName: string;
  gatewayDecision: IntentGatewayDecision | null | undefined;
  policy: AssistantModelSelectionConfig;
  mode: RoutingTierMode;
}): SelectedExecutionProfile | null {
  const providerConfig = input.config.llm[input.providerName];
  if (!providerConfig || providerConfig.enabled === false) return null;
  const providerType = providerConfig.provider?.trim() || input.providerName;
  const providerTier = getProviderTier(providerType);
  const providerLocality = getProviderLocality(providerType);
  if (!providerTier || !providerLocality) return null;

  const expectedContextPressure = isExpectedContextPressure(input.gatewayDecision?.expectedContextPressure)
    ? input.gatewayDecision.expectedContextPressure
    : 'medium';
  const preferredAnswerPath = isPreferredAnswerPath(input.gatewayDecision?.preferredAnswerPath)
    ? input.gatewayDecision.preferredAnswerPath
    : 'tool_loop';
  const shape = buildProfileShape({
    tier: providerTier,
    expectedContextPressure,
    preferredAnswerPath,
  });
  const contextBudget = computeContextBudget({
    baseBudget: input.config.assistant.tools.contextBudget ?? 80_000,
    tier: providerTier,
    expectedContextPressure,
    preferredAnswerPath,
  });
  const providerModel = providerConfig.model?.trim() || undefined;

  return {
    id: shape.id,
    providerName: input.providerName,
    providerType,
    ...(providerModel ? { providerModel } : {}),
    providerLocality,
    providerTier,
    requestedTier: providerLocality === 'local' ? 'local' : 'external',
    preferredAnswerPath,
    expectedContextPressure,
    contextBudget,
    toolContextMode: shape.toolContextMode,
    maxAdditionalSections: shape.maxAdditionalSections,
    maxRuntimeNotices: shape.maxRuntimeNotices,
    fallbackProviderOrder: buildFallbackProviderOrder(
      input.config,
      input.providerName,
      providerTier,
      input.policy,
    ),
    reason: `request-scoped provider override selected provider '${input.providerName}'`,
    routingMode: input.mode,
    selectionSource: 'request_override',
  };
}

function deriveDelegatedExecutionDecision(input: {
  gatewayDecision: IntentGatewayDecision | null | undefined;
  orchestration: OrchestrationRoleDescriptor | null | undefined;
  parentProfile: SelectedExecutionProfile | null | undefined;
}): IntentGatewayDecision | null {
  const descriptor = input.orchestration;
  const gatewayDecision = input.gatewayDecision ?? null;
  const hasGatewayDecision = !!gatewayDecision;
  if (!descriptor) {
    return gatewayDecision;
  }

  const baseRoute = gatewayDecision?.route ?? 'general_assistant';
  const baseOperation = gatewayDecision?.operation ?? 'inspect';
  const baseExecutionClass = gatewayDecision?.executionClass ?? 'tool_orchestration';
  const basePreferredTier = gatewayDecision?.preferredTier
    ?? input.parentProfile?.requestedTier
    ?? 'external';
  const baseRequiresRepoGrounding = gatewayDecision?.requiresRepoGrounding ?? false;
  const baseRequiresToolSynthesis = gatewayDecision?.requiresToolSynthesis ?? true;
  const baseExpectedContextPressure = gatewayDecision?.expectedContextPressure ?? 'medium';
  const basePreferredAnswerPath = gatewayDecision?.preferredAnswerPath ?? 'tool_loop';
  const baseSimpleVsComplex = gatewayDecision?.simpleVsComplex ?? 'simple';

  const originalSummary = gatewayDecision?.summary?.trim();
  const originalPlannedSteps = Array.isArray(gatewayDecision?.plannedSteps)
    ? gatewayDecision.plannedSteps
    : undefined;

  const base: IntentGatewayDecision = {
    route: baseRoute,
    confidence: 'high',
    operation: baseOperation,
    summary: originalSummary ?? 'Delegated workload.',
    turnRelation: gatewayDecision?.turnRelation ?? 'follow_up',
    resolution: 'ready',
    missingFields: [],
    executionClass: baseExecutionClass,
    preferredTier: basePreferredTier,
    requiresRepoGrounding: baseRequiresRepoGrounding,
    requiresToolSynthesis: baseRequiresToolSynthesis,
    expectedContextPressure: baseExpectedContextPressure,
    preferredAnswerPath: basePreferredAnswerPath,
    simpleVsComplex: baseSimpleVsComplex,
    ...(typeof gatewayDecision?.requireExactFileReferences === 'boolean'
      ? { requireExactFileReferences: gatewayDecision.requireExactFileReferences }
      : {}),
    entities: {
      ...(gatewayDecision?.entities ?? {}),
    },
    ...(gatewayDecision?.resolvedContent ? { resolvedContent: gatewayDecision.resolvedContent } : {}),
    ...(gatewayDecision?.provenance ? { provenance: { ...gatewayDecision.provenance } } : {}),
    ...(originalPlannedSteps && originalPlannedSteps.length > 0
      ? { plannedSteps: originalPlannedSteps.map((step) => ({ ...step })) }
      : {}),
  };

  const descriptorLabel = descriptor.label?.trim() || descriptor.role;
  const lenses = new Set(descriptor.lenses ?? []);
  const readOperation = deriveDelegatedReadOperation(base);
  const mutateOperation = lenses.has('provider-admin') ? 'update' : 'run';
  const codingWorkspaceOperation = base.entities?.codingRemoteExecRequested === true
    ? 'run'
    : isExplicitWorkspaceMutationOperation(base.operation)
      ? base.operation
    : descriptor.role === 'implementer'
      && !hasStructuredReadOnlyEvidencePlan(base)
    ? mutateOperation
    : readOperation;
  const preferredDirectTier = base.preferredTier
    ?? input.parentProfile?.requestedTier
    ?? 'local';
  const derivedSummary = originalSummary && originalSummary.length > 0
    ? `${originalSummary} (${descriptorLabel} workload)`
    : `${descriptorLabel} delegated workload.`;
  const withDerivedWorkload = (
    overrides: Partial<IntentGatewayDecision>,
  ): IntentGatewayDecision => ({
    ...base,
    confidence: 'high',
    summary: derivedSummary,
    turnRelation: gatewayDecision?.turnRelation ?? 'follow_up',
    resolution: 'ready',
    missingFields: [],
    ...(base.plannedSteps && base.plannedSteps.length > 0
      ? { plannedSteps: base.plannedSteps.map((step) => ({ ...step })) }
      : {}),
    ...overrides,
    entities: {
      ...base.entities,
      ...(overrides.entities ?? {}),
    },
    provenance: {
      ...(base.provenance ?? {}),
      route: 'derived.workload',
      operation: 'derived.workload',
      executionClass: 'derived.workload',
      preferredTier: 'derived.workload',
      requiresRepoGrounding: 'derived.workload',
      requiresToolSynthesis: 'derived.workload',
      expectedContextPressure: 'derived.workload',
      preferredAnswerPath: 'derived.workload',
      ...(overrides.provenance ?? {}),
    },
  });

  if (lenses.has('security')) {
    if (!requiresSecurityEvidence(base)) {
      return base;
    }
    return withDerivedWorkload({
      route: 'security_task',
      operation: readOperation,
      executionClass: 'security_analysis',
      preferredTier: 'external',
      requiresRepoGrounding: base.requiresRepoGrounding || lenses.has('coding-workspace'),
      requiresToolSynthesis: true,
      expectedContextPressure: 'high',
      preferredAnswerPath: 'chat_synthesis',
    });
  }

  if (lenses.has('coding-workspace')) {
    if (!shouldDeriveCodingWorkspaceDelegatedWorkload(base, hasGatewayDecision)) {
      return base;
    }
    return withDerivedWorkload({
      route: base.route === 'filesystem_task' || base.route === 'coding_session_control'
        ? base.route
        : 'coding_task',
      operation: codingWorkspaceOperation,
      executionClass: 'repo_grounded',
      preferredTier: 'external',
      requiresRepoGrounding: true,
      requiresToolSynthesis: true,
      expectedContextPressure: descriptor.role === 'explorer' ? 'medium' : 'high',
      preferredAnswerPath: descriptor.role === 'verifier' ? 'chat_synthesis' : 'tool_loop',
    });
  }

  if (lenses.has('provider-admin')) {
    return withDerivedWorkload({
      route: base.route === 'email_task' ? 'email_task' : 'workspace_task',
      operation: descriptor.role === 'implementer' ? mutateOperation : readOperation,
      executionClass: 'provider_crud',
      preferredTier: 'external',
      requiresRepoGrounding: false,
      requiresToolSynthesis: true,
      expectedContextPressure: descriptor.role === 'explorer' ? 'low' : 'medium',
      preferredAnswerPath: 'tool_loop',
    });
  }

  if (lenses.has('research')) {
    return withDerivedWorkload({
      route: base.route === 'browser_task' ? 'browser_task' : 'search_task',
      operation: base.route === 'browser_task' ? 'navigate' : 'search',
      executionClass: 'tool_orchestration',
      preferredTier: 'external',
      requiresRepoGrounding: false,
      requiresToolSynthesis: true,
      expectedContextPressure: 'low',
      preferredAnswerPath: 'tool_loop',
    });
  }

  if (lenses.has('personal-assistant') || lenses.has('second-brain')) {
    return withDerivedWorkload({
      route: 'personal_assistant_task',
      operation: descriptor.role === 'implementer' ? mutateOperation : readOperation,
      executionClass: 'direct_assistant',
      preferredTier: preferredDirectTier,
      requiresRepoGrounding: false,
      requiresToolSynthesis: descriptor.role !== 'coordinator',
      expectedContextPressure: descriptor.role === 'coordinator' ? 'low' : 'medium',
      preferredAnswerPath: descriptor.role === 'coordinator' ? 'direct' : 'tool_loop',
    });
  }

  switch (descriptor.role) {
    case 'explorer':
      return withDerivedWorkload({
        route: 'general_assistant',
        operation: readOperation,
        executionClass: 'tool_orchestration',
        preferredTier: 'external',
        requiresRepoGrounding: false,
        requiresToolSynthesis: true,
        expectedContextPressure: 'low',
        preferredAnswerPath: 'tool_loop',
      });
    case 'implementer':
      return withDerivedWorkload({
        route: 'general_assistant',
        operation: mutateOperation,
        executionClass: 'tool_orchestration',
        preferredTier: 'external',
        requiresRepoGrounding: false,
        requiresToolSynthesis: true,
        expectedContextPressure: 'medium',
        preferredAnswerPath: 'tool_loop',
      });
    case 'verifier':
      return withDerivedWorkload({
        route: 'general_assistant',
        operation: readOperation,
        executionClass: 'tool_orchestration',
        preferredTier: 'external',
        requiresRepoGrounding: false,
        requiresToolSynthesis: true,
        expectedContextPressure: 'high',
        preferredAnswerPath: 'chat_synthesis',
      });
    case 'coordinator':
    default:
      return base;
  }
}

function shouldDeriveCodingWorkspaceDelegatedWorkload(
  base: IntentGatewayDecision,
  hasGatewayDecision: boolean,
): boolean {
  if (!hasGatewayDecision) {
    return true;
  }
  return base.route === 'coding_task'
    || base.route === 'filesystem_task'
    || base.route === 'coding_session_control'
    || (
      base.route === 'general_assistant'
      && (base.requiresRepoGrounding === true || base.executionClass === 'repo_grounded')
    );
}

export function resolveDelegatedExecutionDecision(input: {
  gatewayDecision?: IntentGatewayDecision | null;
  orchestration?: OrchestrationRoleDescriptor | null;
  parentProfile?: SelectedExecutionProfile | null;
}): IntentGatewayDecision | null {
  return deriveDelegatedExecutionDecision({
    gatewayDecision: input.gatewayDecision,
    orchestration: input.orchestration,
    parentProfile: input.parentProfile ?? null,
  });
}

function buildProfileShape(input: {
  tier: ProviderTier;
  expectedContextPressure: IntentGatewayExpectedContextPressure;
  preferredAnswerPath: IntentGatewayPreferredAnswerPath;
}): Pick<SelectedExecutionProfile, 'id' | 'toolContextMode' | 'maxAdditionalSections' | 'maxRuntimeNotices'> {
  if (input.tier === 'local') {
    return {
      id: input.preferredAnswerPath === 'direct' ? 'local_direct' : 'local_tool',
      toolContextMode: 'tight',
      maxAdditionalSections: input.expectedContextPressure === 'high' ? 2 : 1,
      maxRuntimeNotices: 2,
    };
  }
  if (input.tier === 'managed_cloud') {
    return {
      id: input.preferredAnswerPath === 'direct' ? 'managed_cloud_direct' : 'managed_cloud_tool',
      toolContextMode: input.expectedContextPressure === 'high' ? 'standard' : 'tight',
      maxAdditionalSections: input.expectedContextPressure === 'high' ? 2 : 1,
      maxRuntimeNotices: input.expectedContextPressure === 'high' ? 3 : 2,
    };
  }
  return {
    id: 'frontier_deep',
    toolContextMode: input.expectedContextPressure === 'high' || input.preferredAnswerPath === 'chat_synthesis'
      ? 'standard'
      : 'tight',
    maxAdditionalSections: input.expectedContextPressure === 'high' ? 4 : 2,
    maxRuntimeNotices: input.expectedContextPressure === 'high' ? 4 : 2,
  };
}

export function selectExecutionProfile(input: {
  config: GuardianAgentConfig;
  routeDecision: Pick<RouteDecision, 'tier'> | null | undefined;
  gatewayDecision: IntentGatewayDecision | null | undefined;
  mode: RoutingTierMode;
  forcedProviderName?: string | null;
}): SelectedExecutionProfile | null {
  const policy = normalizeModelSelectionPolicy(input.config);
  const forcedProviderName = input.forcedProviderName?.trim();
  if (forcedProviderName) {
    const forcedProfile = buildForcedProviderExecutionProfile({
      config: input.config,
      providerName: forcedProviderName,
      gatewayDecision: input.gatewayDecision,
      policy,
      mode: input.mode,
    });
    if (forcedProfile) {
      return forcedProfile;
    }
  }
  const tierSelection = resolveSelectedTier({
    config: input.config,
    routeDecision: input.routeDecision,
    decision: input.gatewayDecision,
    mode: input.mode,
    policy,
  });
  if (!tierSelection) return null;

  const providerName = findProviderByTier(input.config, tierSelection.tier);
  if (!providerName) return null;

  const expectedContextPressure = isExpectedContextPressure(input.gatewayDecision?.expectedContextPressure)
    ? input.gatewayDecision.expectedContextPressure
    : 'medium';
  const preferredAnswerPath = isPreferredAnswerPath(input.gatewayDecision?.preferredAnswerPath)
    ? input.gatewayDecision.preferredAnswerPath
    : 'tool_loop';
  const providerSelection = tierSelection.tier === 'managed_cloud'
    ? getManagedCloudProviderSelection({
      config: input.config,
      decision: input.gatewayDecision,
      preferredAnswerPath,
    })
    : null;
  const effectiveProviderName = providerSelection?.providerName ?? providerName;
  const effectiveProviderType = input.config.llm[effectiveProviderName]?.provider?.trim() || effectiveProviderName;
  const effectiveProviderModel = input.config.llm[effectiveProviderName]?.model?.trim() || undefined;
  const shape = buildProfileShape({
    tier: tierSelection.tier,
    expectedContextPressure,
    preferredAnswerPath,
  });
  const contextBudget = computeContextBudget({
    baseBudget: input.config.assistant.tools.contextBudget ?? 80_000,
    tier: tierSelection.tier,
    expectedContextPressure,
    preferredAnswerPath,
  });
  return {
    id: shape.id,
    providerName: effectiveProviderName,
    providerType: effectiveProviderType,
    ...(effectiveProviderModel ? { providerModel: effectiveProviderModel } : {}),
    providerLocality: getProviderLocality(effectiveProviderName) ?? (tierSelection.tier === 'local' ? 'local' : 'external'),
    providerTier: getProviderTier(effectiveProviderType) ?? tierSelection.tier,
    requestedTier: tierSelection.requestedTier,
    preferredAnswerPath,
    expectedContextPressure,
    contextBudget,
    toolContextMode: shape.toolContextMode,
    maxAdditionalSections: shape.maxAdditionalSections,
    maxRuntimeNotices: shape.maxRuntimeNotices,
    fallbackProviderOrder: buildFallbackProviderOrder(
      input.config,
      effectiveProviderName,
      tierSelection.tier,
      policy,
    ),
    reason: providerSelection?.reasonSuffix
      ? `${tierSelection.reason}; ${providerSelection.reasonSuffix}`
      : tierSelection.reason,
    routingMode: input.mode,
    selectionSource: 'auto',
  };
}

export function selectDelegatedExecutionProfile(input: {
  config: GuardianAgentConfig;
  parentProfile?: SelectedExecutionProfile | null;
  gatewayDecision?: IntentGatewayDecision | null;
  orchestration?: OrchestrationRoleDescriptor | null;
  mode?: RoutingTierMode;
}): SelectedExecutionProfile | null {
  const parentProfile = input.parentProfile ?? null;
  if (parentProfile?.selectionSource === 'request_override') {
    return parentProfile;
  }

  const delegatedDecision = resolveDelegatedExecutionDecision({
    gatewayDecision: input.gatewayDecision,
    orchestration: input.orchestration,
    parentProfile,
  });
  if (!delegatedDecision) {
    return parentProfile;
  }

  const routingMode = parentProfile?.routingMode ?? input.mode ?? 'auto';
  const selected = selectExecutionProfile({
    config: input.config,
    routeDecision: { tier: delegatedDecision.preferredTier },
    gatewayDecision: delegatedDecision,
    mode: routingMode,
  });
  if (!selected) {
    return parentProfile;
  }

  const delegatedLabel = input.orchestration?.label?.trim()
    || input.orchestration?.role
    || 'delegated task';
  return {
    ...selected,
    routingMode,
    selectionSource: 'delegated_role',
    reason: `${selected.reason}; delegated workload derived for ${delegatedLabel}`,
  };
}

export function selectEscalatedDelegatedExecutionProfile(input: {
  config: GuardianAgentConfig;
  currentProfile?: SelectedExecutionProfile | null;
  parentProfile?: SelectedExecutionProfile | null;
  gatewayDecision?: IntentGatewayDecision | null;
  orchestration?: OrchestrationRoleDescriptor | null;
  mode?: RoutingTierMode;
}): SelectedExecutionProfile | null {
  const currentProfile = input.currentProfile ?? null;
  const parentProfile = input.parentProfile ?? currentProfile;
  const routingMode = currentProfile?.routingMode ?? input.mode ?? 'auto';
  if (
    currentProfile?.selectionSource === 'request_override'
    || routingMode === 'local-only'
    || routingMode === 'managed-cloud-only'
    || routingMode === 'frontier-only'
  ) {
    return null;
  }

  if (!findProviderByTier(input.config, 'frontier')) {
    return null;
  }

  const delegatedDecision = resolveDelegatedExecutionDecision({
    gatewayDecision: input.gatewayDecision,
    orchestration: input.orchestration,
    parentProfile,
  });
  if (!delegatedDecision) {
    return null;
  }

  const selected = selectExecutionProfile({
    config: input.config,
    routeDecision: { tier: delegatedDecision.preferredTier },
    gatewayDecision: delegatedDecision,
    mode: 'frontier-only',
  });
  if (!selected) {
    return null;
  }

  if (
    currentProfile
    && selected.providerName === currentProfile.providerName
    && selected.providerTier === currentProfile.providerTier
  ) {
    return null;
  }

  const delegatedLabel = input.orchestration?.label?.trim()
    || input.orchestration?.role
    || 'delegated task';
  return {
    ...selected,
    routingMode,
    selectionSource: 'delegated_role',
    reason: `${selected.reason}; escalated delegated workload for ${delegatedLabel}`,
  };
}

export function selectManagedCloudSiblingDelegatedExecutionProfile(input: {
  config: GuardianAgentConfig;
  currentProfile?: SelectedExecutionProfile | null;
  parentProfile?: SelectedExecutionProfile | null;
  gatewayDecision?: IntentGatewayDecision | null;
  orchestration?: OrchestrationRoleDescriptor | null;
  mode?: RoutingTierMode;
}): SelectedExecutionProfile | null {
  const currentProfile = input.currentProfile ?? null;
  if (!currentProfile || currentProfile.providerTier !== 'managed_cloud') {
    return null;
  }
  const routingMode = currentProfile.routingMode ?? input.mode ?? 'auto';
  if (
    currentProfile.selectionSource === 'request_override'
    || routingMode === 'local-only'
    || routingMode === 'frontier-only'
  ) {
    return null;
  }
  const delegatedDecision = resolveDelegatedExecutionDecision({
    gatewayDecision: input.gatewayDecision,
    orchestration: input.orchestration,
    parentProfile: input.parentProfile ?? currentProfile,
  });
  if (!delegatedDecision) {
    return null;
  }
  const currentProviderName = currentProfile.providerName.trim();
  const candidateProviders = currentProfile.fallbackProviderOrder.filter((providerName) => (
    providerName.trim()
    && providerName !== currentProviderName
  ));
  for (const providerName of candidateProviders) {
    const providerConfig = input.config.llm[providerName];
    if (!providerConfig || providerConfig.enabled === false) {
      continue;
    }
    const providerType = providerConfig.provider?.trim() || providerName;
    if (getProviderTier(providerType) !== 'managed_cloud') {
      continue;
    }
    const selected = selectExecutionProfile({
      config: input.config,
      routeDecision: { tier: 'external' },
      gatewayDecision: delegatedDecision,
      mode: routingMode,
      forcedProviderName: providerName,
    });
    if (!selected || selected.providerName === currentProviderName || selected.providerTier !== 'managed_cloud') {
      continue;
    }
    const delegatedLabel = input.orchestration?.label?.trim()
      || input.orchestration?.role
      || 'delegated task';
    return {
      ...selected,
      routingMode,
      selectionSource: 'delegated_role',
      reason: `managed-cloud sibling retry selected provider '${providerName}' for ${delegatedLabel}`,
    };
  }
  return null;
}

export function serializeSelectedExecutionProfile(
  profile: SelectedExecutionProfile,
): Record<string, unknown> {
  return {
    id: profile.id,
    providerName: profile.providerName,
    providerType: profile.providerType,
    ...(profile.providerModel ? { providerModel: profile.providerModel } : {}),
    providerLocality: profile.providerLocality,
    providerTier: profile.providerTier,
    requestedTier: profile.requestedTier,
    preferredAnswerPath: profile.preferredAnswerPath,
    expectedContextPressure: profile.expectedContextPressure,
    contextBudget: profile.contextBudget,
    toolContextMode: profile.toolContextMode,
    maxAdditionalSections: profile.maxAdditionalSections,
    maxRuntimeNotices: profile.maxRuntimeNotices,
    fallbackProviderOrder: [...profile.fallbackProviderOrder],
    reason: profile.reason,
    ...(profile.routingMode ? { routingMode: profile.routingMode } : {}),
    ...(profile.selectionSource ? { selectionSource: profile.selectionSource } : {}),
  };
}

export function readSelectedExecutionProfileMetadata(
  metadata: Record<string, unknown> | undefined,
): SelectedExecutionProfile | null {
  const value = metadata?.[EXECUTION_PROFILE_METADATA_KEY];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const providerName = typeof record.providerName === 'string' && record.providerName.trim()
    ? record.providerName.trim()
    : '';
  if (!providerName) return null;
  const providerType = typeof record.providerType === 'string' && record.providerType.trim()
    ? record.providerType.trim()
    : '';
  const providerModel = typeof record.providerModel === 'string' && record.providerModel.trim()
    ? record.providerModel.trim()
    : undefined;
  const providerLocality = record.providerLocality === 'local' || record.providerLocality === 'external'
    ? record.providerLocality
    : getProviderLocality(providerName);
  const providerTier = isProviderTier(record.providerTier)
    ? record.providerTier
    : getProviderTier(providerType || providerName);
  const preferredAnswerPath = isPreferredAnswerPath(record.preferredAnswerPath)
    ? record.preferredAnswerPath
    : 'tool_loop';
  const expectedContextPressure = isExpectedContextPressure(record.expectedContextPressure)
    ? record.expectedContextPressure
    : 'medium';
  const toolContextMode = isExecutionProfileToolContextMode(record.toolContextMode)
    ? record.toolContextMode
    : 'tight';
  if (!providerLocality || !providerTier) return null;
  const fallbackProviderOrder = Array.isArray(record.fallbackProviderOrder)
    ? record.fallbackProviderOrder
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim())
    : [providerName];
  return {
    id: record.id === 'local_direct'
      || record.id === 'local_tool'
      || record.id === 'managed_cloud_direct'
      || record.id === 'managed_cloud_tool'
      || record.id === 'frontier_deep'
      ? record.id
      : (providerTier === 'local'
        ? preferredAnswerPath === 'direct' ? 'local_direct' : 'local_tool'
        : providerTier === 'managed_cloud'
          ? preferredAnswerPath === 'direct' ? 'managed_cloud_direct' : 'managed_cloud_tool'
          : 'frontier_deep'),
    providerName,
    providerType: providerType || providerName,
    ...(providerModel ? { providerModel } : {}),
    providerLocality,
    providerTier,
    requestedTier: record.requestedTier === 'local' || record.requestedTier === 'external'
      ? record.requestedTier
      : (providerLocality === 'local' ? 'local' : 'external'),
    preferredAnswerPath,
    expectedContextPressure,
    contextBudget: typeof record.contextBudget === 'number' && Number.isFinite(record.contextBudget)
      ? record.contextBudget
      : 80_000,
    toolContextMode,
    maxAdditionalSections: typeof record.maxAdditionalSections === 'number' && Number.isFinite(record.maxAdditionalSections)
      ? record.maxAdditionalSections
      : 1,
    maxRuntimeNotices: typeof record.maxRuntimeNotices === 'number' && Number.isFinite(record.maxRuntimeNotices)
      ? record.maxRuntimeNotices
      : 2,
    fallbackProviderOrder: fallbackProviderOrder.length > 0 ? fallbackProviderOrder : [providerName],
    reason: typeof record.reason === 'string' && record.reason.trim()
      ? record.reason.trim()
      : 'request-scoped execution profile',
    ...(record.routingMode === 'auto'
      || record.routingMode === 'local-only'
      || record.routingMode === 'managed-cloud-only'
      || record.routingMode === 'frontier-only'
      ? { routingMode: record.routingMode }
      : {}),
    ...(isExecutionProfileSelectionSource(record.selectionSource)
      ? { selectionSource: record.selectionSource }
      : {}),
  };
}

export function attachSelectedExecutionProfileMetadata(
  metadata: Record<string, unknown> | undefined,
  profile: SelectedExecutionProfile | null | undefined,
): Record<string, unknown> | undefined {
  if (!profile) return metadata;
  return {
    ...(metadata ?? {}),
    [EXECUTION_PROFILE_METADATA_KEY]: serializeSelectedExecutionProfile(profile),
  };
}
