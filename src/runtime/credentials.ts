/**
 * Runtime credential resolution for provider and tool integrations.
 *
 * Keeps raw config references separate from the resolved runtime-only view
 * that contains concrete secret values.
 */

import type {
  AssistantCloudConfig,
  AssistantCredentialsConfig,
  CredentialRefConfig,
  GuardianAgentConfig,
  LLMConfig,
  WebSearchConfig,
} from '../config/types.js';

export interface CredentialProvider {
  resolve(ref: string): string | undefined;
  require(ref: string, purpose: string): string;
}

export class ConfigCredentialProvider implements CredentialProvider {
  private readonly refs: Record<string, CredentialRefConfig>;

  constructor(config?: AssistantCredentialsConfig) {
    this.refs = { ...(config?.refs ?? {}) };
  }

  resolve(ref: string): string | undefined {
    const entry = this.refs[ref];
    if (!entry) return undefined;
    if (entry.source !== 'env') return undefined;

    const value = process.env[entry.env];
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  }

  require(ref: string, purpose: string): string {
    const entry = this.refs[ref];
    if (!entry) {
      throw new Error(`Credential reference '${ref}' not found for ${purpose}`);
    }

    const value = this.resolve(ref);
    if (!value) {
      throw new Error(
        `Credential reference '${ref}' for ${purpose} did not resolve to a non-empty value. ` +
        `Expected environment variable '${entry.env}'.`,
      );
    }

    return value;
  }
}

function resolveCredentialValue(
  directValue: string | undefined,
  credentialRef: string | undefined,
  provider: CredentialProvider,
  purpose: string,
): string | undefined {
  const ref = credentialRef?.trim();
  if (ref) return provider.require(ref, purpose);

  const direct = directValue?.trim();
  return direct ? direct : undefined;
}

export function resolveLLMCredentialConfig(
  configs: Record<string, LLMConfig>,
  provider: CredentialProvider,
): Record<string, LLMConfig> {
  return Object.fromEntries(
    Object.entries(configs).map(([name, cfg]) => {
      const resolved: LLMConfig = { ...cfg };
      if (cfg.provider !== 'ollama') {
        resolved.apiKey = resolveCredentialValue(
          cfg.apiKey,
          cfg.credentialRef,
          provider,
          `llm.${name}`,
        );
        if (!resolved.apiKey) {
          throw new Error(`No resolved credential available for llm.${name}`);
        }
      }
      return [name, resolved];
    }),
  );
}

export function resolveWebSearchCredentialConfig(
  config: WebSearchConfig | undefined,
  provider: CredentialProvider,
): WebSearchConfig | undefined {
  if (!config) return config;

  return {
    ...config,
    braveApiKey: resolveCredentialValue(
      config.braveApiKey,
      config.braveCredentialRef,
      provider,
      'assistant.tools.webSearch.brave',
    ),
    perplexityApiKey: resolveCredentialValue(
      config.perplexityApiKey,
      config.perplexityCredentialRef,
      provider,
      'assistant.tools.webSearch.perplexity',
    ),
    openRouterApiKey: resolveCredentialValue(
      config.openRouterApiKey,
      config.openRouterCredentialRef,
      provider,
      'assistant.tools.webSearch.openRouter',
    ),
  };
}

export function resolveCloudCredentialConfig(
  config: AssistantCloudConfig | undefined,
  provider: CredentialProvider,
): AssistantCloudConfig | undefined {
  if (!config) return config;

  return {
    ...config,
    cpanelProfiles: (config.cpanelProfiles ?? []).map((profile) => ({
      ...profile,
      apiToken: resolveCredentialValue(
        profile.apiToken,
        profile.credentialRef,
        provider,
        `assistant.tools.cloud.cpanelProfiles.${profile.id}`,
      ),
    })),
    vercelProfiles: (config.vercelProfiles ?? []).map((profile) => ({
      ...profile,
      apiToken: resolveCredentialValue(
        profile.apiToken,
        profile.credentialRef,
        provider,
        `assistant.tools.cloud.vercelProfiles.${profile.id}`,
      ),
    })),
    cloudflareProfiles: (config.cloudflareProfiles ?? []).map((profile) => ({
      ...profile,
      apiToken: resolveCredentialValue(
        profile.apiToken,
        profile.credentialRef,
        provider,
        `assistant.tools.cloud.cloudflareProfiles.${profile.id}`,
      ),
    })),
    awsProfiles: (config.awsProfiles ?? []).map((profile) => ({
      ...profile,
      accessKeyId: resolveCredentialValue(
        profile.accessKeyId,
        profile.accessKeyIdCredentialRef,
        provider,
        `assistant.tools.cloud.awsProfiles.${profile.id}.accessKeyId`,
      ),
      secretAccessKey: resolveCredentialValue(
        profile.secretAccessKey,
        profile.secretAccessKeyCredentialRef,
        provider,
        `assistant.tools.cloud.awsProfiles.${profile.id}.secretAccessKey`,
      ),
      sessionToken: resolveCredentialValue(
        profile.sessionToken,
        profile.sessionTokenCredentialRef,
        provider,
        `assistant.tools.cloud.awsProfiles.${profile.id}.sessionToken`,
      ),
    })),
  };
}

export function resolveRuntimeCredentialView(
  config: GuardianAgentConfig,
): {
  credentialProvider: CredentialProvider;
  resolvedLLM: Record<string, LLMConfig>;
  resolvedWebSearch: WebSearchConfig | undefined;
  resolvedCloud: AssistantCloudConfig | undefined;
} {
  const credentialProvider = new ConfigCredentialProvider(config.assistant.credentials);
  return {
    credentialProvider,
    resolvedLLM: resolveLLMCredentialConfig(config.llm, credentialProvider),
    resolvedWebSearch: resolveWebSearchCredentialConfig(config.assistant.tools.webSearch, credentialProvider),
    resolvedCloud: resolveCloudCredentialConfig(config.assistant.tools.cloud, credentialProvider),
  };
}
