/**
 * Rate limiter — admission controller for request throttling.
 *
 * Layer 1 defense: prevents DoS via message flooding or expensive LLM calls.
 * Tracks per-agent request timestamps in sliding windows.
 */

import type { AdmissionController, AdmissionPhase, AdmissionResult, AgentAction } from './guardian.js';

/** Configuration for rate limiting. */
export interface RateLimiterConfig {
  /** Maximum requests per minute per agent (default: 30). */
  maxPerMinute: number;
  /** Maximum requests per hour per agent (default: 500). */
  maxPerHour: number;
  /** Maximum burst requests within 10 seconds (default: 5). */
  burstAllowed: number;
  /** Maximum requests per minute per user across all agents (default: maxPerMinute). */
  maxPerMinutePerUser?: number;
  /** Maximum requests per hour per user across all agents (default: maxPerHour). */
  maxPerHourPerUser?: number;
  /** Maximum requests per minute globally (default: maxPerMinute * 10). */
  maxGlobalPerMinute?: number;
  /** Maximum requests per hour globally (default: maxPerHour * 10). */
  maxGlobalPerHour?: number;
}

const DEFAULT_CONFIG: RateLimiterConfig = {
  maxPerMinute: 30,
  maxPerHour: 500,
  burstAllowed: 5,
};

/**
 * Rate limiter admission controller.
 *
 * Validating phase: checks per-agent request rates across three windows
 * (burst/10s, per-minute, per-hour). Only limits message_dispatch actions.
 */
export class RateLimiter implements AdmissionController {
  readonly name = 'RateLimiter';
  readonly phase: AdmissionPhase = 'validating';

  private windows: Map<string, number[]> = new Map();
  private config: RateLimiterConfig;

  constructor(config?: Partial<RateLimiterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  check(action: AgentAction): AdmissionResult | null {
    // Only rate-limit message dispatch
    if (action.type !== 'message_dispatch') return null;

    const userId = typeof action.params['userId'] === 'string'
      ? action.params['userId'].trim()
      : '';
    const channel = typeof action.params['channel'] === 'string'
      ? action.params['channel'].trim()
      : '';
    const now = Date.now();
    const scopes: Array<{
      key: string;
      label: string;
      maxPerMinute: number;
      maxPerHour: number;
      includeBurst: boolean;
    }> = [
      {
        key: `agent:${action.agentId}`,
        label: `agent '${action.agentId}'`,
        maxPerMinute: this.config.maxPerMinute,
        maxPerHour: this.config.maxPerHour,
        includeBurst: true,
      },
      {
        key: '__global__',
        label: 'global',
        maxPerMinute: this.config.maxGlobalPerMinute ?? this.config.maxPerMinute * 10,
        maxPerHour: this.config.maxGlobalPerHour ?? this.config.maxPerHour * 10,
        includeBurst: false,
      },
    ];
    if (userId && channel !== 'scheduled') {
      scopes.push({
        key: `user:${userId}`,
        label: `user '${userId}'`,
        maxPerMinute: this.config.maxPerMinutePerUser ?? this.config.maxPerMinute,
        maxPerHour: this.config.maxPerHourPerUser ?? this.config.maxPerHour,
        includeBurst: true,
      });
    }

    for (const scope of scopes) {
      const timestamps = this.windows.get(scope.key) ?? [];
      const recent = timestamps.filter((t) => now - t < 3_600_000);

      if (scope.includeBurst) {
        const burstCount = recent.filter((t) => now - t < 10_000).length;
        if (burstCount >= this.config.burstAllowed) {
          return {
            allowed: false,
            reason: `Rate limit: burst exceeded for ${scope.label} (${burstCount}/${this.config.burstAllowed} in 10s)`,
            controller: this.name,
          };
        }
      }

      const minuteCount = recent.filter((t) => now - t < 60_000).length;
      if (minuteCount >= scope.maxPerMinute) {
        return {
          allowed: false,
          reason: `Rate limit: per-minute exceeded for ${scope.label} (${minuteCount}/${scope.maxPerMinute})`,
          controller: this.name,
        };
      }

      if (recent.length >= scope.maxPerHour) {
        return {
          allowed: false,
          reason: `Rate limit: per-hour exceeded for ${scope.label} (${recent.length}/${scope.maxPerHour})`,
          controller: this.name,
        };
      }
    }

    // Record this request after all scopes pass.
    for (const scope of scopes) {
      const timestamps = this.windows.get(scope.key) ?? [];
      const recent = timestamps.filter((t) => now - t < 3_600_000);
      recent.push(now);
      this.windows.set(scope.key, recent);
    }
    return null;
  }

  /** Reset rate limit state for an agent. */
  reset(agentId: string): void {
    this.windows.delete(`agent:${agentId}`);
  }

  /** Reset all rate limit state. */
  resetAll(): void {
    this.windows.clear();
  }
}
