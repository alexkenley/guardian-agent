import { randomUUID } from 'node:crypto';

import { deepMerge, validateConfig } from '../../config/loader.js';
import { applyDerivedDefaultProvider } from '../../config/default-provider-resolution.js';
import { normalizeOptionalHttpUrlInput } from '../../config/input-normalization.js';
import type { CredentialRefConfig, GuardianAgentConfig } from '../../config/types.js';
import type { ConfigUpdate, DashboardMutationResult } from '../../channels/web-types.js';
import type { AssistantJobTracker } from '../assistant-jobs.js';
import {
  isDeploymentProfile,
  isSecurityOperatingMode,
  isSecurityTriageLlmProvider,
} from '../security-controls.js';
import { normalizeCpanelConnectionConfig } from '../../tools/cloud/cpanel-profile.js';

interface SecurityBaselineViolationLike {
  field: string;
  attempted: unknown;
  enforced: unknown;
}

interface DirectConfigUpdateHandlerOptions {
  configRef: { current: GuardianAgentConfig };
  jobTracker: AssistantJobTracker;
  loadRawConfig: () => Record<string, unknown>;
  persistAndApplyConfig: (
    rawConfig: Record<string, unknown>,
    meta?: { changedBy?: string; reason?: string },
  ) => { success: boolean; message: string };
  normalizeCredentialRefUpdates: (refs: Record<string, {
    source?: 'env' | 'local';
    env?: string;
    secretId?: string;
    secretValue?: string;
    description?: string;
  }>) => Record<string, {
    source: 'env' | 'local';
    env?: string;
    secretId?: string;
    description?: string;
  }>;
  storeSecret: (secretId: string, value: string) => void;
  deleteUnusedLocalSecrets: (
    previousRefs: Record<string, { source: 'env' | 'local'; env?: string; secretId?: string; description?: string }>,
    nextRefs: Record<string, { source: 'env' | 'local'; env?: string; secretId?: string; description?: string }>,
  ) => void;
  mergeCloudConfigForValidation: (
    current: GuardianAgentConfig['assistant']['tools']['cloud'],
    update: NonNullable<NonNullable<ConfigUpdate['assistant']>['tools']>['cloud'] | undefined,
  ) => GuardianAgentConfig['assistant']['tools']['cloud'];
  previewSecurityBaselineViolations: (
    nextConfig: GuardianAgentConfig,
    source: 'web_api',
  ) => SecurityBaselineViolationLike[];
  buildSecurityBaselineRejection: (
    violations: SecurityBaselineViolationLike[],
    source: 'config_update',
    attemptedChange: Record<string, unknown>,
  ) => DashboardMutationResult;
  trackSystemAnalytics: (type: string, metadata?: Record<string, unknown>) => void;
  upsertLocalCredentialRef: (
    rawConfig: Record<string, unknown>,
    refName: string,
    secretValue: string,
    description: string,
  ) => string;
  existingProfilesById: (rawCloud: Record<string, unknown>, key: string) => Map<string, Record<string, unknown>>;
  trimOrUndefined: (value: unknown) => string | undefined;
  hasOwn: (value: object, key: string) => boolean;
  isRecord: (value: unknown) => value is Record<string, unknown>;
  sanitizeNormalizedUrlRecord: (value: unknown) => Record<string, string> | undefined;
}

type LlmConfigUpdate = NonNullable<ConfigUpdate['llm']>[string];

function buildNextLlmConfig(
  currentLlm: GuardianAgentConfig['llm'],
  llmPatch: Record<string, LlmConfigUpdate>,
): GuardianAgentConfig['llm'] {
  const nextLlm: GuardianAgentConfig['llm'] = { ...currentLlm };

  for (const [name, providerUpdates] of Object.entries(llmPatch)) {
    if (providerUpdates.remove === true) {
      delete nextLlm[name];
      continue;
    }

    const currentProvider = nextLlm[name] ?? ({} as GuardianAgentConfig['llm'][string]);
    nextLlm[name] = {
      ...currentProvider,
      ...(providerUpdates.provider !== undefined ? { provider: providerUpdates.provider } : {}),
      ...(providerUpdates.enabled !== undefined ? { enabled: providerUpdates.enabled } : {}),
      ...(providerUpdates.model !== undefined ? { model: providerUpdates.model } : {}),
      ...(providerUpdates.credentialRef !== undefined ? { credentialRef: providerUpdates.credentialRef } : {}),
      ...(providerUpdates.baseUrl !== undefined ? { baseUrl: providerUpdates.baseUrl } : {}),
      ...(providerUpdates.maxTokens !== undefined ? { maxTokens: providerUpdates.maxTokens } : {}),
      ...(providerUpdates.temperature !== undefined ? { temperature: providerUpdates.temperature } : {}),
      ...(providerUpdates.timeoutMs !== undefined ? { timeoutMs: providerUpdates.timeoutMs } : {}),
      ...(providerUpdates.keepAlive !== undefined ? { keepAlive: providerUpdates.keepAlive } : {}),
      ...(providerUpdates.think !== undefined ? { think: providerUpdates.think } : {}),
      ...(providerUpdates.ollamaOptions !== undefined ? { ollamaOptions: providerUpdates.ollamaOptions } : {}),
    };
  }

  return nextLlm;
}

function countEnabledProviders(llm: GuardianAgentConfig['llm']): number {
  return Object.values(llm).filter((provider) => provider.enabled !== false).length;
}

function pruneDeletedProviderReferences(
  config: GuardianAgentConfig,
  removedProviderNames: Set<string>,
): void {
  if (removedProviderNames.size === 0) return;

  if (Array.isArray(config.fallbacks)) {
    config.fallbacks = config.fallbacks.filter((name) => !removedProviderNames.has(name) && name !== config.defaultProvider);
  }

  const preferredProviders = config.assistant.tools?.preferredProviders;
  if (preferredProviders) {
    for (const key of ['local', 'managedCloud', 'frontier', 'external'] as const) {
      if (preferredProviders[key] && removedProviderNames.has(preferredProviders[key])) {
        delete preferredProviders[key];
      }
    }
  }

  const roleBindings = config.assistant.tools?.modelSelection?.managedCloudRouting?.roleBindings;
  if (roleBindings) {
    for (const role of ['general', 'direct', 'toolLoop', 'coding'] as const) {
      if (roleBindings[role] && removedProviderNames.has(roleBindings[role])) {
        delete roleBindings[role];
      }
    }
    if (Object.keys(roleBindings).length === 0) {
      delete config.assistant.tools.modelSelection!.managedCloudRouting!.roleBindings;
    }
  }
}

function pruneDeletedProviderReferencesFromRawConfig(
  rawConfig: Record<string, unknown>,
  removedProviderNames: Set<string>,
  defaultProvider: string,
): void {
  if (removedProviderNames.size === 0) return;

  const rawFallbacks = Array.isArray(rawConfig.fallbacks) ? rawConfig.fallbacks : undefined;
  if (rawFallbacks) {
    rawConfig.fallbacks = rawFallbacks.filter((name) => (
      typeof name === 'string'
      && !removedProviderNames.has(name)
      && name !== defaultProvider
    ));
  }

  const rawAssistant = rawConfig.assistant as Record<string, unknown> | undefined;
  const rawTools = rawAssistant?.tools as Record<string, unknown> | undefined;
  const rawPreferredProviders = rawTools?.preferredProviders as Record<string, unknown> | undefined;
  if (rawPreferredProviders) {
    for (const key of ['local', 'managedCloud', 'frontier', 'external'] as const) {
      const value = rawPreferredProviders[key];
      if (typeof value === 'string' && removedProviderNames.has(value)) {
        delete rawPreferredProviders[key];
      }
    }
  }

  const rawManagedCloudRouting = rawTools?.modelSelection && typeof rawTools.modelSelection === 'object'
    ? (rawTools.modelSelection as Record<string, unknown>).managedCloudRouting as Record<string, unknown> | undefined
    : undefined;
  const rawRoleBindings = rawManagedCloudRouting?.roleBindings as Record<string, unknown> | undefined;
  if (rawRoleBindings) {
    for (const role of ['general', 'direct', 'toolLoop', 'coding'] as const) {
      const value = rawRoleBindings[role];
      if (typeof value === 'string' && removedProviderNames.has(value)) {
        delete rawRoleBindings[role];
      }
    }
    if (rawManagedCloudRouting && Object.keys(rawRoleBindings).length === 0) {
      delete rawManagedCloudRouting.roleBindings;
    }
  }
}

export function createDirectConfigUpdateHandler(options: DirectConfigUpdateHandlerOptions) {
  return async function applyDirectConfigUpdate(updates: ConfigUpdate): Promise<DashboardMutationResult> {
    return options.jobTracker.run(
      {
        type: 'config.update',
        source: 'manual',
        detail: 'Direct config update',
        metadata: {},
      },
      async () => {
        const updatesWithLegacyDefault = updates as ConfigUpdate & { defaultProvider?: string };
        if (updatesWithLegacyDefault.defaultProvider !== undefined) {
          return {
            success: false,
            message: 'Primary provider is derived automatically from the routed provider configuration. Update the managed-cloud, local, or frontier defaults instead.',
            statusCode: 400,
          };
        }
        const currentConfig = options.configRef.current;
        let credentialRefsChanged = !!updates.assistant?.credentials?.refs;
        const diskRefsForBase = (() => {
          try {
            const raw = options.loadRawConfig();
            const creds = (raw?.assistant as Record<string, unknown>)?.credentials as Record<string, unknown> | undefined;
            return (creds?.refs ?? {}) as Record<string, CredentialRefConfig>;
          } catch {
            return {} as Record<string, CredentialRefConfig>;
          }
        })();
        const nextCredentialRefs = updates.assistant?.credentials?.refs
          ? options.normalizeCredentialRefUpdates(updates.assistant.credentials.refs)
          : { ...diskRefsForBase, ...(currentConfig.assistant.credentials.refs ?? {}) };
        const removedProviderNames = new Set<string>();
        const llmPatch: Record<string, LlmConfigUpdate> | undefined = updates.llm
          ? Object.fromEntries(Object.entries(updates.llm).map(([name, providerUpdates]) => {
            if (providerUpdates.remove === true) {
              removedProviderNames.add(name);
              return [name, { remove: true }];
            }
            let credentialRef = providerUpdates.credentialRef;
            if (providerUpdates.apiKey?.trim()) {
              const refName = providerUpdates.credentialRef?.trim()
                || currentConfig.llm[name]?.credentialRef?.trim()
                || `llm.${name}.local`;
              const existingRef = nextCredentialRefs[refName];
              const secretId = existingRef?.source === 'local' && existingRef.secretId?.trim()
                ? existingRef.secretId.trim()
                : randomUUID();
              nextCredentialRefs[refName] = {
                source: 'local',
                secretId,
                description: `${name} provider credential`,
              };
              credentialRefsChanged = true;
              options.storeSecret(secretId, providerUpdates.apiKey.trim());
              credentialRef = refName;
            }
            return [name, {
              ...providerUpdates,
              remove: undefined,
              apiKey: undefined,
              credentialRef,
            }];
          })) as Record<string, LlmConfigUpdate>
          : undefined;
        const telegramUpdates = updates.channels?.telegram
          ? { ...updates.channels.telegram }
          : undefined;
        if (telegramUpdates?.botToken?.trim()) {
          const refName = telegramUpdates.botTokenCredentialRef?.trim()
            || currentConfig.channels.telegram?.botTokenCredentialRef?.trim()
            || 'telegram.bot.primary';
          const existingRef = nextCredentialRefs[refName];
          const secretId = existingRef?.source === 'local' && existingRef.secretId?.trim()
            ? existingRef.secretId.trim()
            : randomUUID();
          nextCredentialRefs[refName] = {
            source: 'local',
            secretId,
            description: 'Telegram bot token',
          };
          credentialRefsChanged = true;
          options.storeSecret(secretId, telegramUpdates.botToken.trim());
          telegramUpdates.botTokenCredentialRef = refName;
          telegramUpdates.botToken = undefined;
        } else if (telegramUpdates) {
          const existingRefName = telegramUpdates.botTokenCredentialRef?.trim()
            || currentConfig.channels.telegram?.botTokenCredentialRef?.trim();
          if (existingRefName && !nextCredentialRefs[existingRefName]) {
            try {
              const rawOnDisk = options.loadRawConfig();
              const diskRefs = (rawOnDisk?.assistant as Record<string, unknown>)?.credentials as Record<string, unknown> | undefined;
              const diskRef = (diskRefs?.refs as Record<string, Record<string, unknown>> | undefined)?.[existingRefName];
              if (diskRef && typeof diskRef.secretId === 'string') {
                nextCredentialRefs[existingRefName] = {
                  source: (diskRef.source as string) || 'local',
                  secretId: diskRef.secretId,
                  description: (diskRef.description as string) || 'Telegram bot token',
                } as typeof nextCredentialRefs[string];
                credentialRefsChanged = true;
              }
            } catch {
              // Best-effort recovery — validation will flag the missing ref
            }
          }
        }
        const cloudPatch = updates.assistant?.tools?.cloud
          ? options.mergeCloudConfigForValidation(currentConfig.assistant.tools.cloud, updates.assistant.tools.cloud)
          : undefined;
        const assistantPatch = updates.assistant || credentialRefsChanged
          ? {
            ...(updates.assistant ?? {}),
            credentials: credentialRefsChanged || updates.assistant?.credentials
              ? {
                refs: nextCredentialRefs,
              }
              : undefined,
            tools: updates.assistant?.tools
              ? {
                ...updates.assistant.tools,
                ...(cloudPatch ? { cloud: cloudPatch } : {}),
              }
              : undefined,
          }
          : undefined;

        const patch = {
          llm: llmPatch as unknown as GuardianAgentConfig['llm'] | undefined,
          channels: updates.channels
            ? {
              ...updates.channels,
              telegram: telegramUpdates,
            } as unknown as GuardianAgentConfig['channels']
            : undefined,
          assistant: assistantPatch as unknown as GuardianAgentConfig['assistant'] | undefined,
        } as Partial<GuardianAgentConfig>;
        const nextConfig = deepMerge(currentConfig, patch);
        if (llmPatch) {
          nextConfig.llm = buildNextLlmConfig(currentConfig.llm, llmPatch);
        }
        if (removedProviderNames.size > 0) {
          pruneDeletedProviderReferences(nextConfig, removedProviderNames);
        }
        applyDerivedDefaultProvider(nextConfig);
        if (countEnabledProviders(nextConfig.llm) === 0) {
          return {
            success: false,
            message: 'At least one AI provider must stay enabled.',
            statusCode: 400,
          };
        }
        const baselineViolations = options.previewSecurityBaselineViolations(nextConfig, 'web_api');
        if (baselineViolations.length > 0) {
          return options.buildSecurityBaselineRejection(
            baselineViolations,
            'config_update',
            updates as unknown as Record<string, unknown>,
          );
        }
        const errors = validateConfig(nextConfig);
        if (errors.length > 0) {
          options.trackSystemAnalytics('config_update_failed', { errors });
          return {
            success: false,
            message: `Validation failed: ${errors.join('; ')}`,
          };
        }

        const rawConfig = options.loadRawConfig();

        if (llmPatch) {
          const llmSection = (rawConfig.llm ?? {}) as Record<string, Record<string, unknown>>;
          for (const [name, providerUpdates] of Object.entries(llmPatch) as Array<[string, LlmConfigUpdate]>) {
            if (providerUpdates.remove === true) {
              delete llmSection[name];
              continue;
            }
            if (!llmSection[name]) {
              llmSection[name] = {};
            }
            if (providerUpdates.provider) llmSection[name].provider = providerUpdates.provider;
            if (providerUpdates.enabled !== undefined) llmSection[name].enabled = providerUpdates.enabled;
            if (providerUpdates.model) llmSection[name].model = providerUpdates.model;
            delete llmSection[name].apiKey;
            if (providerUpdates.credentialRef !== undefined) {
              const trimmed = providerUpdates.credentialRef.trim();
              if (trimmed) llmSection[name].credentialRef = trimmed;
              else delete llmSection[name].credentialRef;
            }
            if (providerUpdates.baseUrl !== undefined) {
              const trimmed = normalizeOptionalHttpUrlInput(providerUpdates.baseUrl);
              if (trimmed) llmSection[name].baseUrl = trimmed;
              else delete llmSection[name].baseUrl;
            }
            if (providerUpdates.maxTokens !== undefined) {
              llmSection[name].maxTokens = providerUpdates.maxTokens;
            }
            if (providerUpdates.temperature !== undefined) {
              llmSection[name].temperature = providerUpdates.temperature;
            }
            if (providerUpdates.timeoutMs !== undefined) {
              llmSection[name].timeoutMs = providerUpdates.timeoutMs;
            }
            if (providerUpdates.keepAlive !== undefined) {
              llmSection[name].keepAlive = providerUpdates.keepAlive;
            }
            if (providerUpdates.think !== undefined) {
              llmSection[name].think = providerUpdates.think;
            }
            if (providerUpdates.ollamaOptions !== undefined) {
              if (
                typeof providerUpdates.ollamaOptions === 'object'
                && providerUpdates.ollamaOptions !== null
                && !Array.isArray(providerUpdates.ollamaOptions)
                && Object.keys(providerUpdates.ollamaOptions).length > 0
              ) {
                llmSection[name].ollamaOptions = providerUpdates.ollamaOptions;
              } else {
                delete llmSection[name].ollamaOptions;
              }
            }
          }
          rawConfig.llm = llmSection;
        }

        rawConfig.defaultProvider = nextConfig.defaultProvider;
        if (removedProviderNames.size > 0) {
          pruneDeletedProviderReferencesFromRawConfig(rawConfig, removedProviderNames, nextConfig.defaultProvider);
        }

        if (telegramUpdates) {
          rawConfig.channels = rawConfig.channels ?? {};
          const rawChannels = rawConfig.channels as Record<string, unknown>;
          const rawTelegram = (rawChannels.telegram as Record<string, unknown> | undefined) ?? {};

          if (typeof telegramUpdates.enabled === 'boolean') {
            rawTelegram.enabled = telegramUpdates.enabled;
          }
          if (typeof telegramUpdates.polling === 'boolean') {
            rawTelegram.polling = telegramUpdates.polling;
          }
          if (telegramUpdates.defaultAgent !== undefined) {
            const trimmed = telegramUpdates.defaultAgent.trim();
            if (trimmed) rawTelegram.defaultAgent = trimmed;
            else delete rawTelegram.defaultAgent;
          }
          delete rawTelegram.botToken;
          if (telegramUpdates.botTokenCredentialRef !== undefined) {
            const trimmed = telegramUpdates.botTokenCredentialRef.trim();
            if (trimmed) rawTelegram.botTokenCredentialRef = trimmed;
            else delete rawTelegram.botTokenCredentialRef;
          }
          if (telegramUpdates.allowedChatIds !== undefined) {
            if (telegramUpdates.allowedChatIds.length > 0) rawTelegram.allowedChatIds = telegramUpdates.allowedChatIds;
            else delete rawTelegram.allowedChatIds;
          }

          rawChannels.telegram = rawTelegram;
        }

        if (credentialRefsChanged) {
          rawConfig.assistant = rawConfig.assistant ?? {};
          const rawAssistant = rawConfig.assistant as Record<string, unknown>;
          rawAssistant.credentials = (rawAssistant.credentials as Record<string, unknown> | undefined) ?? {};
          const rawCredentials = rawAssistant.credentials as Record<string, unknown>;
          const existingDiskRefs = (rawCredentials.refs as Record<string, unknown>) ?? {};
          rawCredentials.refs = { ...existingDiskRefs, ...nextCredentialRefs };
        }

        const secondBrainUpdates = updates.assistant?.secondBrain;
        if (secondBrainUpdates && typeof secondBrainUpdates === 'object') {
          rawConfig.assistant = rawConfig.assistant ?? {};
          const rawAssistant = rawConfig.assistant as Record<string, unknown>;
          rawAssistant.secondBrain = (rawAssistant.secondBrain as Record<string, unknown> | undefined) ?? {};
          const rawSecondBrain = rawAssistant.secondBrain as Record<string, unknown>;

          if (typeof secondBrainUpdates.enabled === 'boolean') {
            rawSecondBrain.enabled = secondBrainUpdates.enabled;
          }

          const onboardingUpdates = secondBrainUpdates.onboarding;
          if (onboardingUpdates && typeof onboardingUpdates === 'object') {
            rawSecondBrain.onboarding = (rawSecondBrain.onboarding as Record<string, unknown> | undefined) ?? {};
            const rawOnboarding = rawSecondBrain.onboarding as Record<string, unknown>;
            if (typeof onboardingUpdates.completed === 'boolean') {
              rawOnboarding.completed = onboardingUpdates.completed;
            }
            if (typeof onboardingUpdates.dismissed === 'boolean') {
              rawOnboarding.dismissed = onboardingUpdates.dismissed;
            }
          }

          const profileUpdates = secondBrainUpdates.profile;
          if (profileUpdates && typeof profileUpdates === 'object') {
            rawSecondBrain.profile = (rawSecondBrain.profile as Record<string, unknown> | undefined) ?? {};
            const rawProfile = rawSecondBrain.profile as Record<string, unknown>;
            if (options.hasOwn(profileUpdates, 'timezone')) {
              const trimmed = options.trimOrUndefined(profileUpdates.timezone);
              if (trimmed) rawProfile.timezone = trimmed;
              else delete rawProfile.timezone;
            }
            if (options.hasOwn(profileUpdates, 'workdayStart')) {
              const trimmed = options.trimOrUndefined(profileUpdates.workdayStart);
              if (trimmed) rawProfile.workdayStart = trimmed;
              else delete rawProfile.workdayStart;
            }
            if (options.hasOwn(profileUpdates, 'workdayEnd')) {
              const trimmed = options.trimOrUndefined(profileUpdates.workdayEnd);
              if (trimmed) rawProfile.workdayEnd = trimmed;
              else delete rawProfile.workdayEnd;
            }
            if (profileUpdates.proactivityLevel !== undefined) {
              const trimmed = options.trimOrUndefined(profileUpdates.proactivityLevel);
              if (trimmed) rawProfile.proactivityLevel = trimmed;
              else delete rawProfile.proactivityLevel;
            }
          }

          const deliveryUpdates = secondBrainUpdates.delivery;
          if (deliveryUpdates && typeof deliveryUpdates === 'object' && Array.isArray(deliveryUpdates.defaultChannels)) {
            rawSecondBrain.delivery = (rawSecondBrain.delivery as Record<string, unknown> | undefined) ?? {};
            const rawDelivery = rawSecondBrain.delivery as Record<string, unknown>;
            rawDelivery.defaultChannels = deliveryUpdates.defaultChannels
              .map((channel) => options.trimOrUndefined(channel))
              .filter((channel): channel is string => channel === 'web' || channel === 'cli' || channel === 'telegram');
          }

          const knowledgeUpdates = secondBrainUpdates.knowledge;
          if (knowledgeUpdates && typeof knowledgeUpdates === 'object') {
            rawSecondBrain.knowledge = (rawSecondBrain.knowledge as Record<string, unknown> | undefined) ?? {};
            const rawKnowledge = rawSecondBrain.knowledge as Record<string, unknown>;
            if (typeof knowledgeUpdates.prioritizeConnectedSources === 'boolean') {
              rawKnowledge.prioritizeConnectedSources = knowledgeUpdates.prioritizeConnectedSources;
            }
            if (knowledgeUpdates.defaultRetrievalMode !== undefined) {
              const trimmed = options.trimOrUndefined(knowledgeUpdates.defaultRetrievalMode);
              if (trimmed) rawKnowledge.defaultRetrievalMode = trimmed;
              else delete rawKnowledge.defaultRetrievalMode;
            }
            if (typeof knowledgeUpdates.rerankerEnabled === 'boolean') {
              rawKnowledge.rerankerEnabled = knowledgeUpdates.rerankerEnabled;
            }
          }
        }

        const securityUpdates = updates.assistant?.security;
        if (securityUpdates && typeof securityUpdates === 'object') {
          rawConfig.assistant = rawConfig.assistant ?? {};
          const rawAssistant = rawConfig.assistant as Record<string, unknown>;
          rawAssistant.security = (rawAssistant.security as Record<string, unknown> | undefined) ?? {};
          const rawSecurity = rawAssistant.security as Record<string, unknown>;

          if (securityUpdates.deploymentProfile !== undefined) {
            const trimmed = securityUpdates.deploymentProfile.trim();
            if (!trimmed) {
              delete rawSecurity.deploymentProfile;
            } else if (isDeploymentProfile(trimmed)) {
              rawSecurity.deploymentProfile = trimmed;
            }
          }
          if (securityUpdates.operatingMode !== undefined) {
            const trimmed = securityUpdates.operatingMode.trim();
            if (!trimmed) {
              delete rawSecurity.operatingMode;
            } else if (isSecurityOperatingMode(trimmed)) {
              rawSecurity.operatingMode = trimmed;
            }
          }
          if (securityUpdates.triageLlmProvider !== undefined) {
            const trimmed = securityUpdates.triageLlmProvider.trim().toLowerCase();
            if (!trimmed) {
              delete rawSecurity.triageLlmProvider;
            } else if (isSecurityTriageLlmProvider(trimmed)) {
              rawSecurity.triageLlmProvider = trimmed;
            }
          }
          const monitoringUpdates = securityUpdates.continuousMonitoring;
          if (monitoringUpdates && typeof monitoringUpdates === 'object') {
            rawSecurity.continuousMonitoring = (rawSecurity.continuousMonitoring as Record<string, unknown> | undefined) ?? {};
            const rawMonitoring = rawSecurity.continuousMonitoring as Record<string, unknown>;
            if (typeof monitoringUpdates.enabled === 'boolean') {
              rawMonitoring.enabled = monitoringUpdates.enabled;
            }
            if (monitoringUpdates.profileId !== undefined) {
              const trimmed = monitoringUpdates.profileId.trim();
              if (trimmed) rawMonitoring.profileId = trimmed;
              else delete rawMonitoring.profileId;
            }
            if (monitoringUpdates.cron !== undefined) {
              const trimmed = monitoringUpdates.cron.trim();
              if (trimmed) rawMonitoring.cron = trimmed;
              else delete rawMonitoring.cron;
            }
          }
          const autoContainmentUpdates = securityUpdates.autoContainment;
          if (autoContainmentUpdates && typeof autoContainmentUpdates === 'object') {
            rawSecurity.autoContainment = (rawSecurity.autoContainment as Record<string, unknown> | undefined) ?? {};
            const rawAutoContainment = rawSecurity.autoContainment as Record<string, unknown>;
            if (typeof autoContainmentUpdates.enabled === 'boolean') {
              rawAutoContainment.enabled = autoContainmentUpdates.enabled;
            }
            if (autoContainmentUpdates.minSeverity !== undefined) {
              const trimmed = autoContainmentUpdates.minSeverity.trim();
              if (trimmed) rawAutoContainment.minSeverity = trimmed;
              else delete rawAutoContainment.minSeverity;
            }
            if (typeof autoContainmentUpdates.minConfidence === 'number' && Number.isFinite(autoContainmentUpdates.minConfidence)) {
              rawAutoContainment.minConfidence = autoContainmentUpdates.minConfidence;
            }
            if (Array.isArray(autoContainmentUpdates.categories)) {
              rawAutoContainment.categories = autoContainmentUpdates.categories
                .map((category) => category?.trim())
                .filter((category): category is string => !!category);
            }
          }
        }

        const memoryUpdates = updates.assistant?.memory;
        if (memoryUpdates && typeof memoryUpdates === 'object') {
          rawConfig.assistant = rawConfig.assistant ?? {};
          const rawAssistant = rawConfig.assistant as Record<string, unknown>;
          rawAssistant.memory = (rawAssistant.memory as Record<string, unknown> | undefined) ?? {};
          const rawMemory = rawAssistant.memory as Record<string, unknown>;

          const knowledgeBaseUpdates = (memoryUpdates.knowledgeBase && typeof memoryUpdates.knowledgeBase === 'object')
            ? memoryUpdates.knowledgeBase
            : undefined;
          if (knowledgeBaseUpdates) {
            rawMemory.knowledgeBase = (rawMemory.knowledgeBase as Record<string, unknown> | undefined) ?? {};
            const rawKnowledgeBase = rawMemory.knowledgeBase as Record<string, unknown>;

            if (typeof knowledgeBaseUpdates.enabled === 'boolean') {
              rawKnowledgeBase.enabled = knowledgeBaseUpdates.enabled;
            }
            if (knowledgeBaseUpdates.basePath !== undefined) {
              const trimmed = options.trimOrUndefined(knowledgeBaseUpdates.basePath);
              if (trimmed) rawKnowledgeBase.basePath = trimmed;
              else delete rawKnowledgeBase.basePath;
            }
            if (typeof knowledgeBaseUpdates.readOnly === 'boolean') {
              rawKnowledgeBase.readOnly = knowledgeBaseUpdates.readOnly;
            }
            if (typeof knowledgeBaseUpdates.maxContextChars === 'number' && Number.isFinite(knowledgeBaseUpdates.maxContextChars)) {
              rawKnowledgeBase.maxContextChars = knowledgeBaseUpdates.maxContextChars;
            }
            if (typeof knowledgeBaseUpdates.maxFileChars === 'number' && Number.isFinite(knowledgeBaseUpdates.maxFileChars)) {
              rawKnowledgeBase.maxFileChars = knowledgeBaseUpdates.maxFileChars;
            }
            if (typeof knowledgeBaseUpdates.maxEntryChars === 'number' && Number.isFinite(knowledgeBaseUpdates.maxEntryChars)) {
              rawKnowledgeBase.maxEntryChars = knowledgeBaseUpdates.maxEntryChars;
            }
            if (typeof knowledgeBaseUpdates.maxEntriesPerScope === 'number' && Number.isFinite(knowledgeBaseUpdates.maxEntriesPerScope)) {
              rawKnowledgeBase.maxEntriesPerScope = knowledgeBaseUpdates.maxEntriesPerScope;
            }
            if (typeof knowledgeBaseUpdates.maxEmbeddingCacheBytes === 'number' && Number.isFinite(knowledgeBaseUpdates.maxEmbeddingCacheBytes)) {
              rawKnowledgeBase.maxEmbeddingCacheBytes = knowledgeBaseUpdates.maxEmbeddingCacheBytes;
            }
            if (typeof knowledgeBaseUpdates.autoFlush === 'boolean') {
              rawKnowledgeBase.autoFlush = knowledgeBaseUpdates.autoFlush;
            }
          }
        }

        const performanceUpdates = updates.assistant?.performance;
        if (performanceUpdates && typeof performanceUpdates === 'object') {
          rawConfig.assistant = rawConfig.assistant ?? {};
          const rawAssistant = rawConfig.assistant as Record<string, unknown>;
          rawAssistant.performance = (rawAssistant.performance as Record<string, unknown> | undefined) ?? {};
          const rawPerformance = rawAssistant.performance as Record<string, unknown>;

          if (typeof performanceUpdates.enabled === 'boolean') {
            rawPerformance.enabled = performanceUpdates.enabled;
          }
          if (typeof performanceUpdates.sampleIntervalSec === 'number' && Number.isFinite(performanceUpdates.sampleIntervalSec)) {
            rawPerformance.sampleIntervalSec = performanceUpdates.sampleIntervalSec;
          }
          if (typeof performanceUpdates.trendRetentionDays === 'number' && Number.isFinite(performanceUpdates.trendRetentionDays)) {
            rawPerformance.trendRetentionDays = performanceUpdates.trendRetentionDays;
          }

          const protectedProcessesUpdates = performanceUpdates.protectedProcesses;
          if (protectedProcessesUpdates && typeof protectedProcessesUpdates === 'object') {
            rawPerformance.protectedProcesses = (rawPerformance.protectedProcesses as Record<string, unknown> | undefined) ?? {};
            const rawProtectedProcesses = rawPerformance.protectedProcesses as Record<string, unknown>;
            if (Array.isArray(protectedProcessesUpdates.names)) {
              rawProtectedProcesses.names = protectedProcessesUpdates.names
                .map((name) => options.trimOrUndefined(name))
                .filter((name): name is string => !!name);
            }
            if (typeof protectedProcessesUpdates.honorActiveCodeSessions === 'boolean') {
              rawProtectedProcesses.honorActiveCodeSessions = protectedProcessesUpdates.honorActiveCodeSessions;
            }
          }

          if (Array.isArray(performanceUpdates.profiles)) {
            rawPerformance.profiles = performanceUpdates.profiles.map((profile) => {
              const nextProfile: Record<string, unknown> = {
                id: profile.id.trim(),
                name: profile.name.trim(),
              };

              if (
                profile.powerMode === 'balanced'
                || profile.powerMode === 'high_performance'
                || profile.powerMode === 'power_saver'
              ) {
                nextProfile.powerMode = profile.powerMode;
              }

              if (profile.autoActions && typeof profile.autoActions === 'object') {
                const allowedActionIds = Array.isArray(profile.autoActions.allowedActionIds)
                  ? profile.autoActions.allowedActionIds
                    .map((actionId) => options.trimOrUndefined(actionId))
                    .filter((actionId): actionId is string => !!actionId)
                  : [];
                if (typeof profile.autoActions.enabled === 'boolean' || allowedActionIds.length > 0) {
                  nextProfile.autoActions = {
                    enabled: profile.autoActions.enabled === true,
                    allowedActionIds,
                  };
                }
              }

              if (profile.processRules && typeof profile.processRules === 'object') {
                const terminate = Array.isArray(profile.processRules.terminate)
                  ? profile.processRules.terminate
                    .map((name) => options.trimOrUndefined(name))
                    .filter((name): name is string => !!name)
                  : [];
                const protect = Array.isArray(profile.processRules.protect)
                  ? profile.processRules.protect
                    .map((name) => options.trimOrUndefined(name))
                    .filter((name): name is string => !!name)
                  : [];
                if (terminate.length > 0 || protect.length > 0) {
                  nextProfile.processRules = {};
                  if (terminate.length > 0) {
                    (nextProfile.processRules as Record<string, unknown>).terminate = terminate;
                  }
                  if (protect.length > 0) {
                    (nextProfile.processRules as Record<string, unknown>).protect = protect;
                  }
                }
              }

              if (Array.isArray(profile.latencyTargets)) {
                const latencyTargets = profile.latencyTargets
                  .map((target) => {
                    const id = options.trimOrUndefined(target.id);
                    if (!id) return null;
                    const normalizedTarget = options.trimOrUndefined(target.target);
                    const normalizedTargetRef = options.trimOrUndefined(target.targetRef);
                    const nextTarget: Record<string, unknown> = {
                      kind: target.kind,
                      id,
                    };
                    if (normalizedTarget) {
                      nextTarget.target = normalizedTarget;
                    }
                    if (normalizedTargetRef) {
                      nextTarget.targetRef = normalizedTargetRef;
                    }
                    return nextTarget;
                  })
                  .filter((target): target is Record<string, unknown> => target !== null);
                if (latencyTargets.length > 0) {
                  nextProfile.latencyTargets = latencyTargets;
                }
              }

              return nextProfile;
            });
          }
        }

        const notificationUpdates = updates.assistant?.notifications;
        if (notificationUpdates && typeof notificationUpdates === 'object') {
          rawConfig.assistant = rawConfig.assistant ?? {};
          const rawAssistant = rawConfig.assistant as Record<string, unknown>;
          rawAssistant.notifications = (rawAssistant.notifications as Record<string, unknown> | undefined) ?? {};
          const rawNotifications = rawAssistant.notifications as Record<string, unknown>;

          if (typeof notificationUpdates.enabled === 'boolean') {
            rawNotifications.enabled = notificationUpdates.enabled;
          }
          if (notificationUpdates.minSeverity === 'info' || notificationUpdates.minSeverity === 'warn' || notificationUpdates.minSeverity === 'critical') {
            rawNotifications.minSeverity = notificationUpdates.minSeverity;
          }
          if (Array.isArray(notificationUpdates.auditEventTypes)) {
            rawNotifications.auditEventTypes = notificationUpdates.auditEventTypes;
          }
          if (Array.isArray(notificationUpdates.suppressedDetailTypes)) {
            rawNotifications.suppressedDetailTypes = notificationUpdates.suppressedDetailTypes;
          }
          if (typeof notificationUpdates.cooldownMs === 'number' && Number.isFinite(notificationUpdates.cooldownMs)) {
            rawNotifications.cooldownMs = notificationUpdates.cooldownMs;
          }
          if (notificationUpdates.deliveryMode === 'all' || notificationUpdates.deliveryMode === 'selected') {
            rawNotifications.deliveryMode = notificationUpdates.deliveryMode;
          }
          if (notificationUpdates.destinations && typeof notificationUpdates.destinations === 'object') {
            rawNotifications.destinations = (rawNotifications.destinations as Record<string, unknown> | undefined) ?? {};
            const rawDestinations = rawNotifications.destinations as Record<string, unknown>;
            if (typeof notificationUpdates.destinations.web === 'boolean') rawDestinations.web = notificationUpdates.destinations.web;
            if (typeof notificationUpdates.destinations.cli === 'boolean') rawDestinations.cli = notificationUpdates.destinations.cli;
            if (typeof notificationUpdates.destinations.telegram === 'boolean') rawDestinations.telegram = notificationUpdates.destinations.telegram;
          }
        }

        const preferredProviderUpdates = updates.assistant?.tools?.preferredProviders;
        const modelSelectionUpdates = updates.assistant?.tools?.modelSelection;
        if (modelSelectionUpdates && typeof modelSelectionUpdates === 'object') {
          rawConfig.assistant = rawConfig.assistant ?? {};
          const rawAssistant = rawConfig.assistant as Record<string, unknown>;
          rawAssistant.tools = (rawAssistant.tools as Record<string, unknown> | undefined) ?? {};
          const rawTools = rawAssistant.tools as Record<string, unknown>;
          rawTools.modelSelection = {
            ...((rawTools.modelSelection as Record<string, unknown> | undefined) ?? {}),
          };
          const rawModelSelection = rawTools.modelSelection as Record<string, unknown>;

          if (modelSelectionUpdates.autoPolicy === 'balanced' || modelSelectionUpdates.autoPolicy === 'quality_first') {
            rawModelSelection.autoPolicy = modelSelectionUpdates.autoPolicy;
          }
          if (typeof modelSelectionUpdates.preferManagedCloudForLowPressureExternal === 'boolean') {
            rawModelSelection.preferManagedCloudForLowPressureExternal = modelSelectionUpdates.preferManagedCloudForLowPressureExternal;
          }
          if (typeof modelSelectionUpdates.preferFrontierForRepoGrounded === 'boolean') {
            rawModelSelection.preferFrontierForRepoGrounded = modelSelectionUpdates.preferFrontierForRepoGrounded;
          }
          if (typeof modelSelectionUpdates.preferFrontierForSecurity === 'boolean') {
            rawModelSelection.preferFrontierForSecurity = modelSelectionUpdates.preferFrontierForSecurity;
          }

          const managedCloudRoutingUpdates = modelSelectionUpdates.managedCloudRouting;
          if (managedCloudRoutingUpdates && typeof managedCloudRoutingUpdates === 'object') {
            rawModelSelection.managedCloudRouting = {
              ...((rawModelSelection.managedCloudRouting as Record<string, unknown> | undefined) ?? {}),
            };
            const rawManagedCloudRouting = rawModelSelection.managedCloudRouting as Record<string, unknown>;
            if (typeof managedCloudRoutingUpdates.enabled === 'boolean') {
              rawManagedCloudRouting.enabled = managedCloudRoutingUpdates.enabled;
            }

            const roleBindingsUpdates = managedCloudRoutingUpdates.roleBindings;
            if (roleBindingsUpdates && typeof roleBindingsUpdates === 'object') {
              rawManagedCloudRouting.roleBindings = {
                ...((rawManagedCloudRouting.roleBindings as Record<string, unknown> | undefined) ?? {}),
              };
              const rawRoleBindings = rawManagedCloudRouting.roleBindings as Record<string, unknown>;
              for (const role of ['general', 'direct', 'toolLoop', 'coding'] as const) {
                if (roleBindingsUpdates[role] === undefined) continue;
                const trimmed = roleBindingsUpdates[role]?.trim();
                if (trimmed) rawRoleBindings[role] = trimmed;
                else delete rawRoleBindings[role];
              }
              if (Object.keys(rawRoleBindings).length === 0) {
                delete rawManagedCloudRouting.roleBindings;
              }
            }

            if (Object.keys(rawManagedCloudRouting).length === 0) {
              delete rawModelSelection.managedCloudRouting;
            }
          }
        }

        if (preferredProviderUpdates && typeof preferredProviderUpdates === 'object') {
          rawConfig.assistant = rawConfig.assistant ?? {};
          const rawAssistant = rawConfig.assistant as Record<string, unknown>;
          rawAssistant.tools = (rawAssistant.tools as Record<string, unknown> | undefined) ?? {};
          const rawTools = rawAssistant.tools as Record<string, unknown>;
          rawTools.preferredProviders = {
            ...((rawTools.preferredProviders as Record<string, unknown> | undefined) ?? {}),
          };
          const rawPreferredProviders = rawTools.preferredProviders as Record<string, unknown>;

          if (preferredProviderUpdates.local !== undefined) {
            const trimmed = preferredProviderUpdates.local.trim();
            if (trimmed) rawPreferredProviders.local = trimmed;
            else delete rawPreferredProviders.local;
          }
          if (preferredProviderUpdates.managedCloud !== undefined) {
            const trimmed = preferredProviderUpdates.managedCloud.trim();
            if (trimmed) rawPreferredProviders.managedCloud = trimmed;
            else delete rawPreferredProviders.managedCloud;
          }
          if (preferredProviderUpdates.frontier !== undefined) {
            const trimmed = preferredProviderUpdates.frontier.trim();
            if (trimmed) rawPreferredProviders.frontier = trimmed;
            else delete rawPreferredProviders.frontier;
          }
          if (preferredProviderUpdates.external !== undefined) {
            const trimmed = preferredProviderUpdates.external.trim();
            if (trimmed) rawPreferredProviders.external = trimmed;
            else delete rawPreferredProviders.external;
          }
        }

        const cloudUpdate = updates.assistant?.tools?.cloud;
        if (cloudUpdate && typeof cloudUpdate === 'object') {
          rawConfig.assistant = rawConfig.assistant ?? {};
          const rawAssistant = rawConfig.assistant as Record<string, unknown>;
          rawAssistant.tools = (rawAssistant.tools as Record<string, unknown> | undefined) ?? {};
          const rawTools = rawAssistant.tools as Record<string, unknown>;
          rawTools.cloud = (rawTools.cloud as Record<string, unknown> | undefined) ?? {};
          const rawCloud = rawTools.cloud as Record<string, unknown>;

          if (typeof cloudUpdate.enabled === 'boolean') {
            rawCloud.enabled = cloudUpdate.enabled;
          }

          if (Array.isArray(cloudUpdate.cpanelProfiles)) {
            const previous = options.existingProfilesById(rawCloud, 'cpanelProfiles');
            rawCloud.cpanelProfiles = cloudUpdate.cpanelProfiles.map((profile) => {
              const current = previous.get(profile.id);
              const normalized = normalizeCpanelConnectionConfig({
                host: profile.host.trim(),
                port: typeof profile.port === 'number' && Number.isFinite(profile.port)
                  ? profile.port
                  : typeof current?.port === 'number' && Number.isFinite(current.port)
                    ? current.port
                    : undefined,
                ssl: typeof profile.ssl === 'boolean'
                  ? profile.ssl
                  : typeof current?.ssl === 'boolean'
                    ? current.ssl
                    : undefined,
              });
              const next: Record<string, unknown> = {
                id: profile.id.trim(),
                name: profile.name.trim(),
                type: profile.type,
                host: normalized.host,
                username: profile.username.trim(),
              };
              if (normalized.port !== undefined) next.port = normalized.port;
              if (normalized.ssl !== undefined) next.ssl = normalized.ssl;
              if (typeof profile.allowSelfSigned === 'boolean') next.allowSelfSigned = profile.allowSelfSigned;
              if (options.hasOwn(profile, 'defaultCpanelUser')) {
                const trimmed = options.trimOrUndefined(profile.defaultCpanelUser);
                if (trimmed) next.defaultCpanelUser = trimmed;
              } else if (typeof current?.defaultCpanelUser === 'string') {
                next.defaultCpanelUser = current.defaultCpanelUser;
              }
              if (options.hasOwn(profile, 'credentialRef')) {
                const trimmed = options.trimOrUndefined(profile.credentialRef);
                if (trimmed) next.credentialRef = trimmed;
              } else if (typeof current?.credentialRef === 'string') {
                next.credentialRef = current.credentialRef;
              }
              if (options.hasOwn(profile, 'apiToken')) {
                const trimmed = options.trimOrUndefined(profile.apiToken);
                if (trimmed) next.apiToken = trimmed;
              } else if (typeof current?.apiToken === 'string') {
                next.apiToken = current.apiToken;
              }
              return next;
            });
          }

          if (Array.isArray(cloudUpdate.vercelProfiles)) {
            const previous = options.existingProfilesById(rawCloud, 'vercelProfiles');
            rawCloud.vercelProfiles = cloudUpdate.vercelProfiles.map((profile) => {
              const current = previous.get(profile.id);
              const next: Record<string, unknown> = {
                id: profile.id.trim(),
                name: profile.name.trim(),
              };
              if (options.hasOwn(profile, 'apiBaseUrl')) {
                const trimmed = normalizeOptionalHttpUrlInput(typeof profile.apiBaseUrl === 'string' ? profile.apiBaseUrl : undefined);
                if (trimmed) next.apiBaseUrl = trimmed;
              } else if (typeof current?.apiBaseUrl === 'string') {
                next.apiBaseUrl = current.apiBaseUrl;
              }
              if (options.hasOwn(profile, 'credentialRef')) {
                const trimmed = options.trimOrUndefined(profile.credentialRef);
                if (trimmed) next.credentialRef = trimmed;
              } else if (typeof current?.credentialRef === 'string') {
                next.credentialRef = current.credentialRef;
              }
              if (options.hasOwn(profile, 'apiToken')) {
                const trimmed = options.trimOrUndefined(profile.apiToken);
                if (trimmed) next.apiToken = trimmed;
              } else if (typeof current?.apiToken === 'string') {
                next.apiToken = current.apiToken;
              }
              if (options.hasOwn(profile, 'teamId')) {
                const trimmed = options.trimOrUndefined(profile.teamId);
                if (trimmed) next.teamId = trimmed;
              } else if (typeof current?.teamId === 'string') {
                next.teamId = current.teamId;
              }
              if (options.hasOwn(profile, 'slug')) {
                const trimmed = options.trimOrUndefined(profile.slug);
                if (trimmed) next.slug = trimmed;
              } else if (typeof current?.slug === 'string') {
                next.slug = current.slug;
              }
              return next;
            });
          }

          if (Array.isArray(cloudUpdate.cloudflareProfiles)) {
            const previous = options.existingProfilesById(rawCloud, 'cloudflareProfiles');
            rawCloud.cloudflareProfiles = cloudUpdate.cloudflareProfiles.map((profile) => {
              const current = previous.get(profile.id);
              const next: Record<string, unknown> = {
                id: profile.id.trim(),
                name: profile.name.trim(),
              };
              if (options.hasOwn(profile, 'apiBaseUrl')) {
                const trimmed = normalizeOptionalHttpUrlInput(typeof profile.apiBaseUrl === 'string' ? profile.apiBaseUrl : undefined);
                if (trimmed) next.apiBaseUrl = trimmed;
              } else if (typeof current?.apiBaseUrl === 'string') {
                next.apiBaseUrl = current.apiBaseUrl;
              }
              if (options.hasOwn(profile, 'credentialRef')) {
                const trimmed = options.trimOrUndefined(profile.credentialRef);
                if (trimmed) next.credentialRef = trimmed;
              } else if (typeof current?.credentialRef === 'string') {
                next.credentialRef = current.credentialRef;
              }
              if (options.hasOwn(profile, 'apiToken')) {
                const trimmed = options.trimOrUndefined(profile.apiToken);
                if (trimmed) next.apiToken = trimmed;
              } else if (typeof current?.apiToken === 'string') {
                next.apiToken = current.apiToken;
              }
              if (options.hasOwn(profile, 'accountId')) {
                const trimmed = options.trimOrUndefined(profile.accountId);
                if (trimmed) next.accountId = trimmed;
              } else if (typeof current?.accountId === 'string') {
                next.accountId = current.accountId;
              }
              if (options.hasOwn(profile, 'defaultZoneId')) {
                const trimmed = options.trimOrUndefined(profile.defaultZoneId);
                if (trimmed) next.defaultZoneId = trimmed;
              } else if (typeof current?.defaultZoneId === 'string') {
                next.defaultZoneId = current.defaultZoneId;
              }
              return next;
            });
          }

          if (Array.isArray(cloudUpdate.awsProfiles)) {
            const previous = options.existingProfilesById(rawCloud, 'awsProfiles');
            rawCloud.awsProfiles = cloudUpdate.awsProfiles.map((profile) => {
              const current = previous.get(profile.id);
              const next: Record<string, unknown> = {
                id: profile.id.trim(),
                name: profile.name.trim(),
                region: profile.region.trim(),
              };
              for (const field of [
                'accessKeyId',
                'accessKeyIdCredentialRef',
                'secretAccessKey',
                'secretAccessKeyCredentialRef',
                'sessionToken',
                'sessionTokenCredentialRef',
              ] as const) {
                if (options.hasOwn(profile, field)) {
                  const trimmed = options.trimOrUndefined(profile[field]);
                  if (trimmed) next[field] = trimmed;
                } else if (typeof current?.[field] === 'string') {
                  next[field] = current[field];
                }
              }
              if (options.hasOwn(profile, 'endpoints')) {
                const endpoints = options.sanitizeNormalizedUrlRecord(profile.endpoints);
                if (endpoints) next.endpoints = endpoints;
              } else if (options.isRecord(current?.endpoints)) {
                next.endpoints = current.endpoints;
              }
              return next;
            });
          }

          if (Array.isArray(cloudUpdate.gcpProfiles)) {
            const previous = options.existingProfilesById(rawCloud, 'gcpProfiles');
            rawCloud.gcpProfiles = cloudUpdate.gcpProfiles.map((profile) => {
              const current = previous.get(profile.id);
              const next: Record<string, unknown> = {
                id: profile.id.trim(),
                name: profile.name.trim(),
                projectId: profile.projectId.trim(),
              };
              if (options.hasOwn(profile, 'location')) {
                const trimmed = options.trimOrUndefined(profile.location);
                if (trimmed) next.location = trimmed;
              } else if (typeof current?.location === 'string') {
                next.location = current.location;
              }
              for (const field of [
                'accessToken',
                'accessTokenCredentialRef',
                'serviceAccountJson',
                'serviceAccountCredentialRef',
              ] as const) {
                if (options.hasOwn(profile, field)) {
                  const trimmed = options.trimOrUndefined(profile[field]);
                  if (trimmed) next[field] = trimmed;
                } else if (typeof current?.[field] === 'string') {
                  next[field] = current[field];
                }
              }
              if (options.hasOwn(profile, 'endpoints')) {
                const endpoints = options.sanitizeNormalizedUrlRecord(profile.endpoints);
                if (endpoints) next.endpoints = endpoints;
              } else if (options.isRecord(current?.endpoints)) {
                next.endpoints = current.endpoints;
              }
              return next;
            });
          }

          if (Array.isArray(cloudUpdate.azureProfiles)) {
            const previous = options.existingProfilesById(rawCloud, 'azureProfiles');
            rawCloud.azureProfiles = cloudUpdate.azureProfiles.map((profile) => {
              const current = previous.get(profile.id);
              const next: Record<string, unknown> = {
                id: profile.id.trim(),
                name: profile.name.trim(),
                subscriptionId: profile.subscriptionId.trim(),
              };
              for (const field of [
                'tenantId',
                'accessToken',
                'accessTokenCredentialRef',
                'clientId',
                'clientIdCredentialRef',
                'clientSecret',
                'clientSecretCredentialRef',
                'defaultResourceGroup',
                'blobBaseUrl',
              ] as const) {
                if (options.hasOwn(profile, field)) {
                  const trimmed = field === 'blobBaseUrl'
                    ? normalizeOptionalHttpUrlInput(typeof profile[field] === 'string' ? profile[field] : undefined)
                    : options.trimOrUndefined(profile[field]);
                  if (trimmed) next[field] = trimmed;
                } else if (typeof current?.[field] === 'string') {
                  next[field] = current[field];
                }
              }
              if (options.hasOwn(profile, 'endpoints')) {
                const endpoints = options.sanitizeNormalizedUrlRecord(profile.endpoints);
                if (endpoints) next.endpoints = endpoints;
              } else if (options.isRecord(current?.endpoints)) {
                next.endpoints = current.endpoints;
              }
              return next;
            });
          }
        }

        const searchUpdate = updates.assistant?.tools?.search;
        if (searchUpdate && typeof searchUpdate === 'object') {
          rawConfig.assistant = rawConfig.assistant ?? {};
          const rawAssistant = rawConfig.assistant as Record<string, unknown>;
          rawAssistant.tools = (rawAssistant.tools as Record<string, unknown> | undefined) ?? {};
          const rawTools = rawAssistant.tools as Record<string, unknown>;
          rawTools.search = (rawTools.search as Record<string, unknown> | undefined) ?? {};
          const rawSearch = rawTools.search as Record<string, unknown>;
          if (!Array.isArray(rawSearch.sources)) {
            rawSearch.sources = [];
          }
          if (typeof searchUpdate.enabled === 'boolean') {
            rawSearch.enabled = searchUpdate.enabled;
          }
          if (Array.isArray(searchUpdate.sources)) {
            rawSearch.sources = searchUpdate.sources;
          }
        }

        const codingBackendsUpdate = updates.assistant?.tools?.codingBackends;
        if (codingBackendsUpdate && typeof codingBackendsUpdate === 'object') {
          rawConfig.assistant = rawConfig.assistant ?? {};
          const rawAssistant = rawConfig.assistant as Record<string, unknown>;
          rawAssistant.tools = (rawAssistant.tools as Record<string, unknown> | undefined) ?? {};
          const rawTools = rawAssistant.tools as Record<string, unknown>;
          rawTools.codingBackends = (rawTools.codingBackends as Record<string, unknown> | undefined) ?? {};
          const rawCodingBackends = rawTools.codingBackends as Record<string, unknown>;

          if (typeof codingBackendsUpdate.enabled === 'boolean') {
            rawCodingBackends.enabled = codingBackendsUpdate.enabled;
          }
          if (codingBackendsUpdate.defaultBackend !== undefined) {
            const trimmed = options.trimOrUndefined(codingBackendsUpdate.defaultBackend);
            if (trimmed) rawCodingBackends.defaultBackend = trimmed;
            else delete rawCodingBackends.defaultBackend;
          }
          if (typeof codingBackendsUpdate.maxConcurrentSessions === 'number' && Number.isFinite(codingBackendsUpdate.maxConcurrentSessions)) {
            rawCodingBackends.maxConcurrentSessions = codingBackendsUpdate.maxConcurrentSessions;
          }
          if (typeof codingBackendsUpdate.autoUpdate === 'boolean') {
            rawCodingBackends.autoUpdate = codingBackendsUpdate.autoUpdate;
          }
          if (typeof codingBackendsUpdate.versionCheckIntervalMs === 'number' && Number.isFinite(codingBackendsUpdate.versionCheckIntervalMs)) {
            rawCodingBackends.versionCheckIntervalMs = codingBackendsUpdate.versionCheckIntervalMs;
          }
          if (Array.isArray(codingBackendsUpdate.backends)) {
            const previousBackends = new Map(
              (Array.isArray(rawCodingBackends.backends) ? rawCodingBackends.backends : [])
                .filter(options.isRecord)
                .map((backend) => [typeof backend.id === 'string' ? backend.id.trim() : '', backend] as const)
                .filter(([id]) => !!id),
            );
            rawCodingBackends.backends = codingBackendsUpdate.backends
              .map((backend) => {
                const id = backend.id.trim();
                const name = backend.name.trim();
                const command = backend.command.trim();
                if (!id || !name || !command) return null;
                const current = previousBackends.get(id);
                const next: Record<string, unknown> = {
                  id,
                  name,
                  enabled: backend.enabled !== false,
                  command,
                  args: Array.isArray(backend.args)
                    ? backend.args
                      .map((arg) => arg?.trim())
                      .filter((arg): arg is string => !!arg)
                    : [],
                };
                if (backend.shell?.trim()) next.shell = backend.shell.trim();
                if (backend.versionCommand?.trim()) next.versionCommand = backend.versionCommand.trim();
                if (backend.updateCommand?.trim()) next.updateCommand = backend.updateCommand.trim();
                if (typeof backend.timeoutMs === 'number' && Number.isFinite(backend.timeoutMs)) {
                  next.timeoutMs = backend.timeoutMs;
                }
                if (typeof backend.nonInteractive === 'boolean') {
                  next.nonInteractive = backend.nonInteractive;
                }
                if (backend.env && typeof backend.env === 'object') {
                  const envEntries = Object.entries(backend.env)
                    .map(([key, value]) => [key.trim(), typeof value === 'string' ? value.trim() : ''] as const)
                    .filter(([key, value]) => !!key && value.length > 0);
                  if (envEntries.length > 0) {
                    next.env = Object.fromEntries(envEntries);
                  }
                } else if (options.isRecord(current?.env)) {
                  next.env = current.env;
                }
                return next;
              })
              .filter((backend): backend is Record<string, unknown> => backend !== null);
          }
        }

        const sandboxUpdate = updates.assistant?.tools?.sandbox;
        if (sandboxUpdate && typeof sandboxUpdate === 'object') {
          rawConfig.assistant = rawConfig.assistant ?? {};
          const rawAssistant = rawConfig.assistant as Record<string, unknown>;
          rawAssistant.tools = (rawAssistant.tools as Record<string, unknown> | undefined) ?? {};
          const rawTools = rawAssistant.tools as Record<string, unknown>;
          rawTools.sandbox = (rawTools.sandbox as Record<string, unknown> | undefined) ?? {};
          const rawSandbox = rawTools.sandbox as Record<string, unknown>;
          if (sandboxUpdate.enforcementMode === 'strict' || sandboxUpdate.enforcementMode === 'permissive') {
            rawSandbox.enforcementMode = sandboxUpdate.enforcementMode;
          }
          const degradedFallbackUpdate = sandboxUpdate.degradedFallback;
          if (degradedFallbackUpdate && typeof degradedFallbackUpdate === 'object') {
            rawSandbox.degradedFallback = (rawSandbox.degradedFallback as Record<string, unknown> | undefined) ?? {};
            const rawDegradedFallback = rawSandbox.degradedFallback as Record<string, unknown>;
            if (typeof degradedFallbackUpdate.allowNetworkTools === 'boolean') rawDegradedFallback.allowNetworkTools = degradedFallbackUpdate.allowNetworkTools;
            if (typeof degradedFallbackUpdate.allowBrowserTools === 'boolean') rawDegradedFallback.allowBrowserTools = degradedFallbackUpdate.allowBrowserTools;
            if (typeof degradedFallbackUpdate.allowMcpServers === 'boolean') rawDegradedFallback.allowMcpServers = degradedFallbackUpdate.allowMcpServers;
            if (typeof degradedFallbackUpdate.allowPackageManagers === 'boolean') rawDegradedFallback.allowPackageManagers = degradedFallbackUpdate.allowPackageManagers;
            if (typeof degradedFallbackUpdate.allowManualCodeTerminals === 'boolean') rawDegradedFallback.allowManualCodeTerminals = degradedFallbackUpdate.allowManualCodeTerminals;
          }
        }

        const agentPolicyUpdatesUpdate = updates.assistant?.tools?.agentPolicyUpdates;
        if (agentPolicyUpdatesUpdate && typeof agentPolicyUpdatesUpdate === 'object') {
          rawConfig.assistant = rawConfig.assistant ?? {};
          const rawAssistant = rawConfig.assistant as Record<string, unknown>;
          rawAssistant.tools = (rawAssistant.tools as Record<string, unknown> | undefined) ?? {};
          const rawTools = rawAssistant.tools as Record<string, unknown>;
          rawTools.agentPolicyUpdates = (rawTools.agentPolicyUpdates as Record<string, unknown> | undefined) ?? {};
          const rawAPU = rawTools.agentPolicyUpdates as Record<string, unknown>;
          if (typeof agentPolicyUpdatesUpdate.allowedPaths === 'boolean') rawAPU.allowedPaths = agentPolicyUpdatesUpdate.allowedPaths;
          if (typeof agentPolicyUpdatesUpdate.allowedCommands === 'boolean') rawAPU.allowedCommands = agentPolicyUpdatesUpdate.allowedCommands;
          if (typeof agentPolicyUpdatesUpdate.allowedDomains === 'boolean') rawAPU.allowedDomains = agentPolicyUpdatesUpdate.allowedDomains;
          if (typeof agentPolicyUpdatesUpdate.toolPolicies === 'boolean') rawAPU.toolPolicies = agentPolicyUpdatesUpdate.toolPolicies;
        }

        const mcpUpdate = updates.assistant?.tools?.mcp;
        if (mcpUpdate && typeof mcpUpdate === 'object') {
          rawConfig.assistant = rawConfig.assistant ?? {};
          const rawAssistant = rawConfig.assistant as Record<string, unknown>;
          rawAssistant.tools = (rawAssistant.tools as Record<string, unknown> | undefined) ?? {};
          const rawTools = rawAssistant.tools as Record<string, unknown>;
          rawTools.mcp = (rawTools.mcp as Record<string, unknown> | undefined) ?? {};
          const rawMcp = rawTools.mcp as Record<string, unknown>;
          if (typeof mcpUpdate.enabled === 'boolean') rawMcp.enabled = mcpUpdate.enabled;

          const gwsUpdate = mcpUpdate.managedProviders?.gws;
          if (gwsUpdate && typeof gwsUpdate === 'object') {
            rawMcp.managedProviders = (rawMcp.managedProviders as Record<string, unknown> | undefined) ?? {};
            const rawManaged = rawMcp.managedProviders as Record<string, unknown>;
            rawManaged.gws = (rawManaged.gws as Record<string, unknown> | undefined) ?? {};
            const rawGws = rawManaged.gws as Record<string, unknown>;
            if (typeof gwsUpdate.enabled === 'boolean') rawGws.enabled = gwsUpdate.enabled;
            if (Array.isArray(gwsUpdate.services)) rawGws.services = gwsUpdate.services;
            if (typeof gwsUpdate.command === 'string') rawGws.command = gwsUpdate.command;
          }
        }

        const result = options.persistAndApplyConfig(rawConfig, {
          changedBy: 'config-center',
          reason: 'direct config update',
        });
        options.trackSystemAnalytics(
          result.success ? 'config_update_success' : 'config_update_failed',
          { result: result.message },
        );
        if (result.success && credentialRefsChanged) {
          options.deleteUnusedLocalSecrets(currentConfig.assistant.credentials.refs, nextCredentialRefs);
        }
        return result;
      },
    );
  };
}
