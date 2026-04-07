import type {
  AssistantModelSelectionConfig,
  GuardianAgentConfig,
  ManagedCloudRoutingRole,
  PreferredProviderKey,
  RoutingTierMode,
} from '../config/types.js';
import {
  getProviderLocality,
  getProviderTier,
  type ProviderLocality,
  type ProviderTier,
} from '../llm/provider-metadata.js';
import type {
  IntentGatewayDecision,
  IntentGatewayExpectedContextPressure,
  IntentGatewayPreferredAnswerPath,
} from './intent-gateway.js';
import type { RouteDecision } from './message-router.js';

export type ExecutionProfileId =
  | 'local_direct'
  | 'local_tool'
  | 'managed_cloud_direct'
  | 'managed_cloud_tool'
  | 'frontier_deep';

export type ExecutionProfileToolContextMode = 'tight' | 'standard';

export interface SelectedExecutionProfile {
  id: ExecutionProfileId;
  providerName: string;
  providerType: string;
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

export function providerMatchesTier(
  llmCfg: Pick<GuardianAgentConfig['llm'][string], 'provider'> | undefined,
  tier: ProviderTier,
): boolean {
  if (!llmCfg?.provider) return false;
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
  if (
    input.decision?.route === 'coding_task'
    || input.decision?.executionClass === 'repo_grounded'
    || input.decision?.requiresRepoGrounding === true
  ) {
    return 'coding';
  }
  if (input.preferredAnswerPath === 'tool_loop') {
    return 'toolLoop';
  }
  if (input.preferredAnswerPath === 'direct') {
    return 'direct';
  }
  return 'general';
}

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
  desiredRole: ManagedCloudRoutingRole,
): string | null {
  const managedCloudProviders = Object.entries(config.llm)
    .filter(([, llmCfg]) => providerMatchesTier(llmCfg, 'managed_cloud'))
    .map(([name]) => name)
    .sort((left, right) => left.localeCompare(right));
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
  const roleBindings = managedCloudRouting?.roleBindings;
  const validateManagedCloudProvider = (providerName: string | undefined): string | null => {
    const trimmed = providerName?.trim();
    if (!trimmed) return null;
    return providerMatchesTier(input.config.llm[trimmed], 'managed_cloud') ? trimmed : null;
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
      reasonSuffix: `managed-cloud role '${desiredRole}' fell back to general provider '${general}'`,
    };
  }

  const inferred = findManagedCloudProviderByHeuristic(input.config, desiredRole);
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
  return ['managed_cloud', 'local', 'frontier'];
}

function buildFallbackProviderOrder(
  config: GuardianAgentConfig,
  primaryProvider: string,
  primaryTier: ProviderTier,
  policy: AssistantModelSelectionConfig,
): string[] {
  const ordered: string[] = [primaryProvider];
  for (const tier of buildFallbackTierOrder(primaryTier, policy)) {
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
  if (decision.executionClass === 'security_analysis' && policy.preferFrontierForSecurity) {
    return true;
  }
  if (
    decision.requiresRepoGrounding
    && policy.preferFrontierForRepoGrounded
    && (decision.expectedContextPressure === 'high' || decision.preferredAnswerPath === 'chat_synthesis')
  ) {
    return true;
  }
  if (
    policy.autoPolicy === 'quality_first'
    && (decision.expectedContextPressure === 'high' || decision.preferredAnswerPath === 'chat_synthesis')
  ) {
    return true;
  }
  return false;
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
}): SelectedExecutionProfile | null {
  const policy = normalizeModelSelectionPolicy(input.config);
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
  };
}

export function serializeSelectedExecutionProfile(
  profile: SelectedExecutionProfile,
): Record<string, unknown> {
  return {
    id: profile.id,
    providerName: profile.providerName,
    providerType: profile.providerType,
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
