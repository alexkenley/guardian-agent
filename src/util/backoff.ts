/**
 * Exponential backoff utility.
 *
 * Fixed retry schedule:
 * [30s, 1m, 5m, 15m, 60m]
 */

/** Backoff delays in milliseconds. */
export const ERROR_BACKOFF_SCHEDULE_MS: readonly number[] = [
  30_000,   // 30 seconds
  60_000,   // 1 minute
  300_000,  // 5 minutes
  900_000,  // 15 minutes
  3_600_000, // 60 minutes
];

/**
 * Get the backoff delay for the given number of consecutive errors.
 * Clamps to the last entry for errors beyond the schedule length.
 */
export function getBackoffDelayMs(consecutiveErrors: number): number {
  if (consecutiveErrors <= 0) return 0;
  const index = Math.min(consecutiveErrors - 1, ERROR_BACKOFF_SCHEDULE_MS.length - 1);
  return ERROR_BACKOFF_SCHEDULE_MS[index];
}

/**
 * Check if enough time has passed since the last error to allow a retry.
 */
export function canRetry(retryAfterMs: number, nowMs: number = Date.now()): boolean {
  return nowMs >= retryAfterMs;
}

/**
 * Calculate when the next retry is allowed.
 */
export function nextRetryTime(
  consecutiveErrors: number,
  nowMs: number = Date.now(),
): number {
  return nowMs + getBackoffDelayMs(consecutiveErrors);
}

/** Maximum number of retries before considering an agent dead. */
export const MAX_RETRIES = ERROR_BACKOFF_SCHEDULE_MS.length;
