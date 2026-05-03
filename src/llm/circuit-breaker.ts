/**
 * Circuit breaker for LLM provider resilience.
 *
 * Implements the circuit breaker pattern: closed → open → half_open.
 * Prevents cascading failures when a provider is down.
 */

/** Circuit breaker states. */
export type CircuitState = 'closed' | 'open' | 'half_open';

/** Error classification for failover decisions. */
export type ErrorClass = 'auth' | 'quota' | 'transient' | 'permanent' | 'timeout';

/** Circuit breaker configuration. */
export interface CircuitBreakerConfig {
  /** Number of failures before opening the circuit (default: 3). */
  failureThreshold: number;
  /** Time in ms before attempting half_open recovery (default: 30000). */
  resetTimeoutMs: number;
  /** Successes needed in half_open before closing (default: 1). */
  halfOpenSuccesses: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  resetTimeoutMs: 30_000,
  halfOpenSuccesses: 1,
};

/**
 * Circuit breaker for a single LLM provider.
 *
 * - Closed: requests flow normally
 * - Open: requests are blocked (provider is down)
 * - Half-open: limited requests to test recovery
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private readonly config: CircuitBreakerConfig;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Get the current circuit state. */
  getState(): CircuitState {
    // Check if open circuit should transition to half_open
    if (this.state === 'open') {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.config.resetTimeoutMs) {
        this.state = 'half_open';
        this.successCount = 0;
      }
    }
    return this.state;
  }

  /** Whether a request can be sent through this breaker. */
  canRequest(): boolean {
    const currentState = this.getState();
    return currentState !== 'open';
  }

  /** Record a successful request. May close the circuit. */
  recordSuccess(): void {
    if (this.state === 'half_open') {
      this.successCount++;
      if (this.successCount >= this.config.halfOpenSuccesses) {
        this.state = 'closed';
        this.failureCount = 0;
        this.successCount = 0;
      }
    } else if (this.state === 'closed') {
      // Reset failure count on success
      this.failureCount = 0;
    }
  }

  /** Record a failed request. May open the circuit. Returns the error class. */
  recordFailure(error: unknown): ErrorClass {
    const errorClass = classifyError(error);

    // Only count transient/timeout/quota errors toward the threshold
    if (errorClass === 'transient' || errorClass === 'timeout' || errorClass === 'quota') {
      this.failureCount++;
      this.lastFailureTime = Date.now();

      if (this.failureCount >= this.config.failureThreshold) {
        this.state = 'open';
      }
    } else if (errorClass === 'auth') {
      // Auth errors immediately open
      this.state = 'open';
      this.lastFailureTime = Date.now();
    }

    if (this.state === 'half_open') {
      // Any failure in half_open reopens
      this.state = 'open';
      this.lastFailureTime = Date.now();
    }

    return errorClass;
  }

  /** Reset the circuit breaker to closed state. */
  reset(): void {
    this.state = 'closed';
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = 0;
  }

  /** Get diagnostics info. */
  getInfo(): { state: CircuitState; failureCount: number; lastFailureTime: number } {
    return {
      state: this.getState(),
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime,
    };
  }
}

/** Classify an error for circuit breaker / failover decisions. */
export function classifyError(error: unknown): ErrorClass {
  if (!error) return 'permanent';

  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  const status = (error as { status?: number })?.status ?? 0;
  const code = (error as { code?: string })?.code ?? '';

  // Auth errors — provider-specific, don't retry with same provider
  if (status === 401 || status === 403 || message.includes('unauthorized') || message.includes('forbidden') || message.includes('invalid api key')) {
    return 'auth';
  }

  // Quota / rate limit — may succeed with a different provider
  if (
    status === 429
    || message.includes('rate limit')
    || message.includes('quota')
    || message.includes('too many requests')
    || message.includes('credit balance')
    || message.includes('insufficient credits')
    || message.includes('purchase credits')
  ) {
    return 'quota';
  }

  // Timeout
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || message.includes('timeout') || message.includes('timed out') || message.includes('aborted') || (error instanceof Error && error.name === 'AbortError')) {
    return 'timeout';
  }

  // Transient server errors
  if (status >= 500 || code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ENOTFOUND' || message.includes('network') || message.includes('socket hang up') || message.includes('econnrefused')) {
    return 'transient';
  }

  return 'permanent';
}
