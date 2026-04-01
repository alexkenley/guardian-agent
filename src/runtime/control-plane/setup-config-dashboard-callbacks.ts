import { randomUUID } from 'node:crypto';

import type { DashboardCallbacks, DashboardProviderInfo } from '../../channels/web-types.js';
import { deepMerge, validateConfig } from '../../config/loader.js';
import type { CredentialRefConfig, GuardianAgentConfig } from '../../config/types.js';
import type { AssistantJobTracker } from '../assistant-jobs.js';
import { applyCredentialRefInput } from '../credential-ref-input.js';
import { evaluateSetupStatus } from '../setup.js';

type SetupConfigDashboardCallbacks = Pick<
  DashboardCallbacks,
  | 'onSetupStatus'
  | 'onSetupApply'
  | 'onSearchConfigUpdate'
>;

interface SetupConfigDashboardCallbackOptions {
  configRef: { current: GuardianAgentConfig };
  toolExecutor: { getSandboxHealth: () => ReturnType<NonNullable<DashboardCallbacks['onToolsState']>>['sandbox'] };
  buildProviderInfo: (withConnectivity: boolean) => Promise<DashboardProviderInfo[]>;
  jobTracker: AssistantJobTracker;
  loadRawConfig: () => Record<string, unknown>;
  persistAndApplyConfig: (
    rawConfig: Record<string, unknown>,
    meta?: { changedBy?: string; reason?: string },
  ) => { success: boolean; message: string };
  upsertLocalCredentialRef: (
    rawConfig: Record<string, unknown>,
    refName: string,
    secretValue: string,
    description: string,
  ) => string;
  isLocalProviderEndpoint: (baseUrl: string | undefined, providerType: string | undefined) => boolean;
  getProviderLocality: (llmCfg: { provider?: string; baseUrl?: string } | undefined) => 'local' | 'external';
  trackSystemAnalytics: (type: string, metadata?: Record<string, unknown>) => void;
}

export function createSetupConfigDashboardCallbacks(
  options: SetupConfigDashboardCallbackOptions,
): SetupConfigDashboardCallbacks {
  const applyWebSearchSettings = (
    rawConfig: Record<string, unknown>,
    input: {
      webSearchProvider?: string;
      perplexityApiKey?: string;
      openRouterApiKey?: string;
      braveApiKey?: string;
      perplexityCredentialRef?: string;
      openRouterCredentialRef?: string;
      braveCredentialRef?: string;
      fallbacks?: string[];
    },
  ): void => {
    const hasWebSearch = input.webSearchProvider
      || input.perplexityApiKey !== undefined
      || input.openRouterApiKey !== undefined
      || input.braveApiKey !== undefined
      || input.perplexityCredentialRef !== undefined
      || input.openRouterCredentialRef !== undefined
      || input.braveCredentialRef !== undefined;

    if (hasWebSearch) {
      rawConfig.assistant = rawConfig.assistant ?? {};
      const rawAssistant = rawConfig.assistant as Record<string, unknown>;
      rawAssistant.tools = rawAssistant.tools ?? {};
      const rawTools = rawAssistant.tools as Record<string, unknown>;
      rawTools.webSearch = rawTools.webSearch ?? {};
      const rawWS = rawTools.webSearch as Record<string, unknown>;
      if (input.webSearchProvider) rawWS.provider = input.webSearchProvider;

      const perplexityApiKey = input.perplexityApiKey?.trim();
      const hasPerplexityApiKey = !!perplexityApiKey;
      if (perplexityApiKey) {
        const refName = input.perplexityCredentialRef?.trim()
          || (typeof rawWS.perplexityCredentialRef === 'string' ? rawWS.perplexityCredentialRef : '')
          || 'search.perplexity.local';
        rawWS.perplexityCredentialRef = options.upsertLocalCredentialRef(
          rawConfig,
          refName,
          perplexityApiKey,
          'Perplexity search API key',
        );
      }
      delete rawWS.perplexityApiKey;
      applyCredentialRefInput(rawWS, 'perplexityCredentialRef', input.perplexityCredentialRef, hasPerplexityApiKey);

      const openRouterApiKey = input.openRouterApiKey?.trim();
      const hasOpenRouterApiKey = !!openRouterApiKey;
      if (openRouterApiKey) {
        const refName = input.openRouterCredentialRef?.trim()
          || (typeof rawWS.openRouterCredentialRef === 'string' ? rawWS.openRouterCredentialRef : '')
          || 'search.openrouter.local';
        rawWS.openRouterCredentialRef = options.upsertLocalCredentialRef(
          rawConfig,
          refName,
          openRouterApiKey,
          'OpenRouter search API key',
        );
      }
      delete rawWS.openRouterApiKey;
      applyCredentialRefInput(rawWS, 'openRouterCredentialRef', input.openRouterCredentialRef, hasOpenRouterApiKey);

      const braveApiKey = input.braveApiKey?.trim();
      const hasBraveApiKey = !!braveApiKey;
      if (braveApiKey) {
        const refName = input.braveCredentialRef?.trim()
          || (typeof rawWS.braveCredentialRef === 'string' ? rawWS.braveCredentialRef : '')
          || 'search.brave.local';
        rawWS.braveCredentialRef = options.upsertLocalCredentialRef(
          rawConfig,
          refName,
          braveApiKey,
          'Brave search API key',
        );
      }
      delete rawWS.braveApiKey;
      applyCredentialRefInput(rawWS, 'braveCredentialRef', input.braveCredentialRef, hasBraveApiKey);
    }

    if (input.fallbacks !== undefined) {
      rawConfig.fallbacks = input.fallbacks.length > 0 ? input.fallbacks : undefined;
    }
  };

  return {
    onSetupStatus: async () => {
      const providers = await options.buildProviderInfo(true);
      return evaluateSetupStatus(
        options.configRef.current,
        providers,
        options.toolExecutor.getSandboxHealth(),
      );
    },

    onSetupApply: async (input) => {
      return options.jobTracker.run(
        {
          type: 'config.apply',
          source: 'manual',
          detail: 'Config Center apply',
          metadata: { llmMode: input.llmMode, telegramEnabled: input.telegramEnabled },
        },
        async () => {
          const providerName = input.providerName?.trim() || (input.llmMode === 'ollama' ? 'ollama' : 'primary');
          const existingProvider = options.configRef.current.llm[providerName];
          const providerType = input.providerType
            ?? (input.llmMode === 'ollama' ? 'ollama' : undefined)
            ?? existingProvider?.provider;
          if (!providerType) {
            return { success: false, message: 'providerType is required for new providers' };
          }
          const model = input.model?.trim();
          if (!model) {
            return { success: false, message: 'model is required' };
          }

          const diskRefsForSetup = (() => {
            try {
              const raw = options.loadRawConfig();
              const creds = (raw?.assistant as Record<string, unknown>)?.credentials as Record<string, unknown> | undefined;
              return (creds?.refs ?? {}) as Record<string, CredentialRefConfig>;
            } catch {
              return {} as Record<string, CredentialRefConfig>;
            }
          })();
          const nextCredentialRefs = { ...diskRefsForSetup, ...(options.configRef.current.assistant.credentials.refs ?? {}) };
          const pendingLocalSecrets: Array<{ refName: string; secretId: string; value: string; description: string }> = [];
          let providerCredentialRef = input.credentialRef?.trim() || existingProvider?.credentialRef?.trim() || undefined;
          if (input.apiKey?.trim()) {
            const refName = input.credentialRef?.trim() || providerCredentialRef || `llm.${providerName}.local`;
            const existingRef = nextCredentialRefs[refName];
            const secretId = existingRef?.source === 'local' && existingRef.secretId?.trim()
              ? existingRef.secretId.trim()
              : randomUUID();
            nextCredentialRefs[refName] = {
              source: 'local',
              secretId,
              description: `${providerName} ${providerType} credential`,
            };
            pendingLocalSecrets.push({
              refName,
              secretId,
              value: input.apiKey.trim(),
              description: `${providerName} ${providerType} credential`,
            });
            providerCredentialRef = refName;
          } else if (input.credentialRef !== undefined) {
            providerCredentialRef = input.credentialRef.trim() || undefined;
          }

          const localProviderEndpoint = options.isLocalProviderEndpoint(
            input.baseUrl?.trim() || existingProvider?.baseUrl,
            providerType,
          );
          const providerLocality: 'local' | 'external' = localProviderEndpoint ? 'local' : 'external';
          if (providerType !== 'ollama' && !localProviderEndpoint && !providerCredentialRef) {
            return { success: false, message: 'apiKey or credentialRef is required for external providers' };
          }

          const explicitPreferredProvider = options.configRef.current.assistant.tools.preferredProviders?.[providerLocality]?.trim();
          const shouldSetPreferredProvider = !explicitPreferredProvider
            || options.getProviderLocality(options.configRef.current.llm[explicitPreferredProvider]) !== providerLocality;

          let telegramCredentialRef = options.configRef.current.channels.telegram?.botTokenCredentialRef?.trim() || undefined;
          if (input.telegramBotToken?.trim()) {
            telegramCredentialRef = telegramCredentialRef || 'telegram.bot.primary';
            const existingRef = nextCredentialRefs[telegramCredentialRef];
            const secretId = existingRef?.source === 'local' && existingRef.secretId?.trim()
              ? existingRef.secretId.trim()
              : randomUUID();
            nextCredentialRefs[telegramCredentialRef] = {
              source: 'local',
              secretId,
              description: 'Telegram bot token',
            };
            pendingLocalSecrets.push({
              refName: telegramCredentialRef,
              secretId,
              value: input.telegramBotToken.trim(),
              description: 'Telegram bot token',
            });
          } else if (telegramCredentialRef && !nextCredentialRefs[telegramCredentialRef]) {
            try {
              const rawOnDisk = options.loadRawConfig();
              const diskRefs = (rawOnDisk?.assistant as Record<string, unknown>)?.credentials as Record<string, unknown> | undefined;
              const diskRef = (diskRefs?.refs as Record<string, Record<string, unknown>> | undefined)?.[telegramCredentialRef];
              if (diskRef && typeof diskRef.secretId === 'string') {
                nextCredentialRefs[telegramCredentialRef] = {
                  source: (diskRef.source as string) || 'local',
                  secretId: diskRef.secretId,
                  description: (diskRef.description as string) || 'Telegram bot token',
                } as typeof nextCredentialRefs[string];
              }
            } catch {
              // Best-effort — validation will flag if still missing
            }
          }

          const patch: Partial<GuardianAgentConfig> = {
            llm: {
              [providerName]: {
                provider: providerType,
                model,
                credentialRef: providerCredentialRef,
                baseUrl: input.baseUrl?.trim() || (providerType === 'ollama' ? 'http://127.0.0.1:11434' : undefined),
              },
            } as GuardianAgentConfig['llm'],
            assistant: {
              ...options.configRef.current.assistant,
              credentials: {
                refs: nextCredentialRefs,
              },
              setup: {
                completed: input.setupCompleted ?? true,
              },
            },
          };

          if (shouldSetPreferredProvider) {
            patch.assistant = {
              ...(patch.assistant ?? options.configRef.current.assistant),
              tools: {
                ...options.configRef.current.assistant.tools,
                preferredProviders: {
                  ...options.configRef.current.assistant.tools.preferredProviders,
                  [providerLocality]: providerName,
                },
              },
            };
          }

          if (input.setDefaultProvider !== false) {
            patch.defaultProvider = providerName;
          }

          if (input.telegramEnabled !== undefined) {
            patch.channels = {
              ...options.configRef.current.channels,
              telegram: {
                enabled: input.telegramEnabled,
                polling: options.configRef.current.channels.telegram?.polling ?? true,
                botTokenCredentialRef: telegramCredentialRef,
                allowedChatIds: input.telegramAllowedChatIds ?? options.configRef.current.channels.telegram?.allowedChatIds,
                defaultAgent: options.configRef.current.channels.telegram?.defaultAgent,
              },
            };
          }

          const nextConfig = deepMerge(options.configRef.current, patch);
          const errors = validateConfig(nextConfig);
          if (errors.length > 0) {
            options.trackSystemAnalytics('setup_apply_failed', { errors });
            return { success: false, message: `Validation failed: ${errors.join('; ')}` };
          }

          const rawConfig = options.loadRawConfig();
          rawConfig.assistant = rawConfig.assistant ?? {};
          const rawAssistant = rawConfig.assistant as Record<string, unknown>;
          rawAssistant.setup = {
            ...(rawAssistant.setup as Record<string, unknown> ?? {}),
            completed: input.setupCompleted ?? true,
          };
          rawAssistant.credentials = (rawAssistant.credentials as Record<string, unknown> | undefined) ?? {};
          (rawAssistant.credentials as Record<string, unknown>).refs = {
            ...((rawAssistant.credentials as Record<string, unknown>).refs as Record<string, unknown> ?? {}),
          };
          for (const pending of pendingLocalSecrets) {
            options.upsertLocalCredentialRef(rawConfig, pending.refName, pending.value, pending.description);
          }

          rawConfig.llm = rawConfig.llm ?? {};
          const rawLLM = rawConfig.llm as Record<string, Record<string, unknown>>;
          rawLLM[providerName] = {
            ...(rawLLM[providerName] ?? {}),
            provider: providerType,
            model,
          };
          if (input.baseUrl?.trim()) rawLLM[providerName].baseUrl = input.baseUrl.trim();
          if (providerType === 'ollama' && !rawLLM[providerName].baseUrl) {
            rawLLM[providerName].baseUrl = 'http://127.0.0.1:11434';
          }
          delete rawLLM[providerName].apiKey;
          if (providerCredentialRef !== undefined) {
            const trimmed = providerCredentialRef.trim();
            if (trimmed) rawLLM[providerName].credentialRef = trimmed;
            else delete rawLLM[providerName].credentialRef;
          }

          if (input.setDefaultProvider !== false) {
            rawConfig.defaultProvider = providerName;
          }

          if (shouldSetPreferredProvider) {
            rawConfig.assistant = rawConfig.assistant ?? {};
            const rawAssistantObj = rawConfig.assistant as Record<string, unknown>;
            rawAssistantObj.tools = (rawAssistantObj.tools as Record<string, unknown> | undefined) ?? {};
            const rawTools = rawAssistantObj.tools as Record<string, unknown>;
            rawTools.preferredProviders = {
              ...((rawTools.preferredProviders as Record<string, unknown> | undefined) ?? {}),
              [providerLocality]: providerName,
            };
          }

          if (input.telegramEnabled !== undefined) {
            rawConfig.channels = rawConfig.channels ?? {};
            const rawChannels = rawConfig.channels as Record<string, unknown>;
            const rawTelegram = (rawChannels.telegram as Record<string, unknown> | undefined) ?? {};
            rawTelegram.enabled = input.telegramEnabled;
            rawTelegram.polling = rawTelegram.polling ?? true;
            delete rawTelegram.botToken;
            if (telegramCredentialRef) rawTelegram.botTokenCredentialRef = telegramCredentialRef;
            if (input.telegramAllowedChatIds) rawTelegram.allowedChatIds = input.telegramAllowedChatIds;
            rawChannels.telegram = rawTelegram;
          }

          applyWebSearchSettings(rawConfig, input);

          const result = options.persistAndApplyConfig(rawConfig, {
            changedBy: 'setup-wizard',
            reason: 'setup apply',
          });
          options.trackSystemAnalytics(
            result.success ? 'setup_applied' : 'setup_apply_failed',
            {
              providerName,
              providerType,
              telegramEnabled: input.telegramEnabled,
              result: result.message,
            },
          );
          if (!result.success) return result;

          return {
            success: true,
            message: input.telegramEnabled
              ? 'Setup saved and applied. Telegram channel is being reloaded.'
              : 'Setup saved and applied.',
          };
        },
      );
    },

    onSearchConfigUpdate: async (input) => {
      const rawConfig = options.loadRawConfig();
      applyWebSearchSettings(rawConfig, input);
      const result = options.persistAndApplyConfig(rawConfig, {
        changedBy: 'config-center',
        reason: 'search config update',
      });
      if (!result.success) return result;
      return { success: true, message: 'Search and fallback settings saved.' };
    },
  };
}
