/**
 * Setup/config shared types + status evaluation.
 */

import type { GuardianAgentConfig } from '../config/types.js';
import type { OllamaOptionsConfig, OllamaThinkConfig } from '../config/types.js';
import type { DashboardProviderInfo } from '../channels/web-types.js';
import type { SandboxHealth } from '../sandbox/types.js';
import {
  isDegradedSandboxFallbackActive,
  isStrictSandboxLockdown,
  listEnabledDegradedFallbackAllowances,
} from '../sandbox/security-controls.js';

export interface SetupStep {
  id: string;
  title: string;
  status: 'complete' | 'incomplete' | 'warning';
  detail: string;
}

export interface SetupStatus {
  completed: boolean;
  ready: boolean;
  steps: SetupStep[];
}

export interface SetupApplyInput {
  llmMode: 'ollama' | 'external';
  providerName?: string;
  /** Built-in provider type from the runtime registry (for example ollama/ollama_cloud/openrouter/openai/anthropic/groq/mistral/deepseek/together/xai/google). */
  providerType?: string;
  model?: string;
  apiKey?: string;
  credentialRef?: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  keepAlive?: string | number;
  think?: OllamaThinkConfig;
  ollamaOptions?: OllamaOptionsConfig;
  telegramEnabled?: boolean;
  telegramBotToken?: string;
  telegramAllowedChatIds?: number[];
  setupCompleted?: boolean;
  /** Fallback provider names (keys in llm map) tried when default fails. */
  fallbacks?: string[];
  /** Web search provider preference. */
  webSearchProvider?: 'auto' | 'perplexity' | 'brave' | 'duckduckgo';
  /** Perplexity API key for synthesized search answers. */
  perplexityApiKey?: string;
  /** Credential reference for Perplexity search. */
  perplexityCredentialRef?: string;
  /** OpenRouter API key (Perplexity via proxy — has free tier). */
  openRouterApiKey?: string;
  /** Credential reference for OpenRouter search. */
  openRouterCredentialRef?: string;
  /** Brave Search API key. */
  braveApiKey?: string;
  /** Credential reference for Brave search. */
  braveCredentialRef?: string;
}

export interface SearchConfigInput {
  webSearchProvider?: 'auto' | 'perplexity' | 'brave' | 'duckduckgo';
  perplexityApiKey?: string;
  perplexityCredentialRef?: string;
  openRouterApiKey?: string;
  openRouterCredentialRef?: string;
  braveApiKey?: string;
  braveCredentialRef?: string;
  fallbacks?: string[];
}

export function evaluateSetupStatus(
  config: GuardianAgentConfig,
  providers: DashboardProviderInfo[],
  sandboxHealth?: SandboxHealth,
): SetupStatus {
  const defaultProvider = config.defaultProvider;
  const providerConfigured = !!config.llm[defaultProvider];
  const providerOnline = providers.find((p) => p.name === defaultProvider)?.connected ?? false;

  const steps: SetupStep[] = [];

  steps.push({
    id: 'llm-provider',
    title: 'LLM Provider Configured',
    status: providerConfigured ? 'complete' : 'incomplete',
    detail: providerConfigured
      ? `Primary provider currently resolves to '${defaultProvider}'.`
      : 'No valid primary provider can be derived from the current routing configuration.',
  });

  steps.push({
    id: 'llm-connectivity',
    title: 'LLM Connectivity',
    status: providerOnline ? 'complete' : (providerConfigured ? 'warning' : 'incomplete'),
    detail: providerConfigured
      ? `${defaultProvider} is ${providerOnline ? 'reachable' : 'not reachable from runtime'}.`
      : 'Configure at least one provider first.',
  });

  const telegram = config.channels.telegram;
  const telegramConfigured = !!(telegram?.enabled && (telegram.botToken || telegram.botTokenCredentialRef));
  steps.push({
    id: 'telegram',
    title: 'Telegram Integration',
    status: telegramConfigured ? 'complete' : 'warning',
    detail: telegramConfigured
      ? 'Telegram bot credential is configured.'
      : 'Telegram is optional and currently not configured.',
  });

  const channelsEnabled = !!(config.channels.cli?.enabled || config.channels.web?.enabled || config.channels.telegram?.enabled);
  steps.push({
    id: 'channels',
    title: 'User Channels',
    status: channelsEnabled ? 'complete' : 'incomplete',
    detail: channelsEnabled
      ? 'At least one user channel is enabled.'
      : 'Enable CLI, Web, or Telegram channel.',
  });

  const sandbox = config.assistant.tools.sandbox;
  if (sandbox?.enabled === false) {
    steps.push({
      id: 'sandbox',
      title: 'Tool Sandbox',
      status: 'warning',
      detail: 'OS-level process sandboxing is disabled. Child processes run without sandbox isolation.',
    });
  } else {
    const availability = sandboxHealth?.availability;
    const platform = sandboxHealth?.platform;
    const backend = sandboxHealth?.backend;

    if (isStrictSandboxLockdown(sandbox, sandboxHealth)) {
      steps.push({
        id: 'sandbox',
        title: 'Tool Sandbox',
        status: 'warning',
        detail: `Strict mode is active on ${platform}, so risky subprocess-backed tools are currently blocked until a strong sandbox backend is available. Safer options: run on Linux/Unix with bubblewrap available, or use the Windows portable app with the AppContainer helper.`,
      });
    } else if ((sandbox?.enforcementMode ?? 'strict') === 'permissive') {
      const enabledAllowances = listEnabledDegradedFallbackAllowances(sandbox);
      const degradedDetail = isDegradedSandboxFallbackActive(sandbox, sandboxHealth)
        ? (enabledAllowances.length > 0
          ? `Explicit degraded-backend overrides are enabled for ${enabledAllowances.join(', ')}.`
          : 'Network/search tools, browser automation, third-party MCP servers, install-like package manager commands, and manual code terminals stay blocked until you explicitly enable them.')
        : 'Strong sandboxing is available right now, but permissive mode would still allow degraded fallbacks if the backend disappears later.';
      const riskDetail = availability && platform
        ? `Permissive mode is explicitly enabled on ${platform} with ${availability} sandbox availability (${backend ?? 'unknown backend'}). ${degradedDetail}`
        : `Permissive mode is explicitly enabled. ${degradedDetail}`;
      steps.push({
        id: 'sandbox',
        title: 'Tool Sandbox',
        status: 'warning',
        detail: `${riskDetail} Safer options: run on Linux/Unix with bubblewrap available, or use the Windows portable app bundled with the AppContainer helper. Keep permissive only if you accept higher host risk.`,
      });
    } else {
      steps.push({
        id: 'sandbox',
        title: 'Tool Sandbox',
        status: 'complete',
        detail: availability && platform
          ? `Strict mode is active on ${platform} with ${availability} sandbox availability (${backend ?? 'unknown backend'}).`
          : 'Strict mode is active for tool sandboxing.',
      });
    }
  }

  const ready = steps.every((step) => step.status !== 'incomplete');
  const completed = config.assistant.setup.completed;

  return { completed, ready, steps };
}

export function parseAllowedChatIds(input: string): number[] {
  return input
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((id) => Number.isFinite(id));
}
