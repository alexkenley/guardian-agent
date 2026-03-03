/**
 * Setup/config shared types + status evaluation.
 */

import type { GuardianAgentConfig } from '../config/types.js';
import type { DashboardProviderInfo } from '../channels/web-types.js';

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
  providerType?: 'ollama' | 'openai' | 'anthropic';
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  setDefaultProvider?: boolean;
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
  /** OpenRouter API key (Perplexity via proxy — has free tier). */
  openRouterApiKey?: string;
  /** Brave Search API key. */
  braveApiKey?: string;
}

export function evaluateSetupStatus(
  config: GuardianAgentConfig,
  providers: DashboardProviderInfo[],
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
      ? `Default provider is '${defaultProvider}'.`
      : 'No valid default provider is configured.',
  });

  steps.push({
    id: 'llm-connectivity',
    title: 'LLM Connectivity',
    status: providerOnline ? 'complete' : (providerConfigured ? 'warning' : 'incomplete'),
    detail: providerConfigured
      ? `${defaultProvider} is ${providerOnline ? 'reachable' : 'not reachable from runtime'}.`
      : 'Configure a provider first.',
  });

  const telegram = config.channels.telegram;
  const telegramConfigured = !!(telegram?.enabled && telegram.botToken);
  steps.push({
    id: 'telegram',
    title: 'Telegram Integration',
    status: telegramConfigured ? 'complete' : 'warning',
    detail: telegramConfigured
      ? 'Telegram bot token is configured.'
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
