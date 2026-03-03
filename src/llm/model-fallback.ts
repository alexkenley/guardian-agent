/**
 * Model fallback chain — tries the primary LLM, falls back to alternatives.
 *
 * Unlike FailoverProvider (which wraps ALL providers into one), this is a
 * lighter-weight wrapper used by ChatAgent when a specific chat call fails.
 * It respects per-provider cooldowns so rate-limited providers aren't retried
 * too aggressively.
 *
 * Usage:
 *   const chain = new ModelFallbackChain(providers, ['ollama', 'claude']);
 *   const response = await chain.chatWithFallback(messages, options);
 */

import type { LLMProvider, ChatMessage, ChatResponse, ChatOptions } from './types.js';
import { classifyError, type ErrorClass } from './circuit-breaker.js';
import { createLogger } from '../util/logging.js';

const log = createLogger('model-fallback');

/** Cooldown entry for a provider that recently failed. */
interface CooldownEntry {
  until: number;
  errorClass: ErrorClass;
}

/** Result of a fallback chain attempt, including which provider succeeded. */
export interface FallbackResult {
  response: ChatResponse;
  /** Name of the provider that handled the request. */
  providerName: string;
  /** Whether a fallback was used (false = primary succeeded). */
  usedFallback: boolean;
  /** Providers that were skipped or failed. */
  skipped: string[];
}

/** Cooldown durations per error class (ms). */
const COOLDOWN_MS: Record<ErrorClass, number> = {
  auth: 300_000,       // 5 min — likely needs config fix
  quota: 60_000,       // 1 min — rate limit
  timeout: 15_000,     // 15s — might recover quickly
  transient: 30_000,   // 30s — server issue
  permanent: 0,        // don't cooldown — won't help
};

export class ModelFallbackChain {
  private readonly providers: Map<string, LLMProvider>;
  private readonly order: string[];
  private readonly cooldowns: Map<string, CooldownEntry> = new Map();
  private now: () => number;

  /**
   * @param providers  Map of provider name → LLMProvider instance
   * @param order      Ordered list of provider names to try (primary first)
   * @param now        Clock function (for testing)
   */
  constructor(
    providers: Map<string, LLMProvider>,
    order: string[],
    now?: () => number,
  ) {
    this.providers = providers;
    // Filter to only providers that actually exist in the map
    this.order = order.filter(name => providers.has(name));
    this.now = now ?? Date.now;
  }

  /**
   * Try chat with fallback chain.
   *
   * Tries providers in order, skipping those on cooldown, falling back
   * on transient/quota/timeout errors.
   */
  async chatWithFallback(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): Promise<FallbackResult> {
    const errors: Array<{ name: string; error: unknown; errorClass: ErrorClass }> = [];
    const skipped: string[] = [];
    const now = this.now();

    for (const name of this.order) {
      const provider = this.providers.get(name);
      if (!provider) continue;

      // Check cooldown
      const cooldown = this.cooldowns.get(name);
      if (cooldown && now < cooldown.until) {
        log.debug({ provider: name, cooldownUntil: cooldown.until, errorClass: cooldown.errorClass }, 'Provider on cooldown, skipping');
        skipped.push(name);
        continue;
      }

      try {
        const response = await provider.chat(messages, options);
        // Clear cooldown on success
        this.cooldowns.delete(name);
        return {
          response,
          providerName: name,
          usedFallback: name !== this.order[0],
          skipped,
        };
      } catch (error) {
        const errorClass = classifyError(error);
        errors.push({ name, error, errorClass });

        // Set cooldown
        const cooldownMs = COOLDOWN_MS[errorClass];
        if (cooldownMs > 0) {
          this.cooldowns.set(name, { until: now + cooldownMs, errorClass });
        }

        log.warn(
          { provider: name, errorClass, error: error instanceof Error ? error.message : String(error) },
          'Provider failed, trying next in fallback chain',
        );

        // Auth and permanent errors for this provider — skip to next
        // Transient/quota/timeout — also skip to next
        continue;
      }
    }

    // All providers exhausted
    const lastError = errors[errors.length - 1]?.error;
    throw lastError ?? new Error('All providers in fallback chain exhausted');
  }

  /** Check if a provider is currently on cooldown. */
  isOnCooldown(name: string): boolean {
    const entry = this.cooldowns.get(name);
    if (!entry) return false;
    if (this.now() >= entry.until) {
      this.cooldowns.delete(name);
      return false;
    }
    return true;
  }

  /** Clear all cooldowns (e.g., on manual retry). */
  clearCooldowns(): void {
    this.cooldowns.clear();
  }

  /** Get the list of provider names in this chain. */
  getProviderOrder(): string[] {
    return [...this.order];
  }
}
