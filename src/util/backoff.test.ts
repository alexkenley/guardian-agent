import { describe, it, expect } from 'vitest';
import {
  getBackoffDelayMs,
  canRetry,
  nextRetryTime,
  ERROR_BACKOFF_SCHEDULE_MS,
  MAX_RETRIES,
} from './backoff.js';

describe('Backoff', () => {
  describe('getBackoffDelayMs', () => {
    it('should return 0 for 0 consecutive errors', () => {
      expect(getBackoffDelayMs(0)).toBe(0);
    });

    it('should return 0 for negative errors', () => {
      expect(getBackoffDelayMs(-1)).toBe(0);
    });

    it('should return 30s for first error', () => {
      expect(getBackoffDelayMs(1)).toBe(30_000);
    });

    it('should return 1m for second error', () => {
      expect(getBackoffDelayMs(2)).toBe(60_000);
    });

    it('should return 5m for third error', () => {
      expect(getBackoffDelayMs(3)).toBe(300_000);
    });

    it('should return 15m for fourth error', () => {
      expect(getBackoffDelayMs(4)).toBe(900_000);
    });

    it('should return 60m for fifth error', () => {
      expect(getBackoffDelayMs(5)).toBe(3_600_000);
    });

    it('should clamp to last entry for errors beyond schedule', () => {
      expect(getBackoffDelayMs(10)).toBe(3_600_000);
      expect(getBackoffDelayMs(100)).toBe(3_600_000);
    });

    it('should match the configured retry schedule', () => {
      expect(ERROR_BACKOFF_SCHEDULE_MS).toEqual([
        30_000,
        60_000,
        300_000,
        900_000,
        3_600_000,
      ]);
    });
  });

  describe('canRetry', () => {
    it('should allow retry when time has passed', () => {
      expect(canRetry(1000, 2000)).toBe(true);
    });

    it('should allow retry at exact time', () => {
      expect(canRetry(1000, 1000)).toBe(true);
    });

    it('should deny retry before time', () => {
      expect(canRetry(2000, 1000)).toBe(false);
    });
  });

  describe('nextRetryTime', () => {
    it('should calculate correct retry time', () => {
      expect(nextRetryTime(1, 1000)).toBe(31_000); // 1000 + 30_000
      expect(nextRetryTime(2, 1000)).toBe(61_000); // 1000 + 60_000
    });
  });

  describe('MAX_RETRIES', () => {
    it('should equal the backoff schedule length', () => {
      expect(MAX_RETRIES).toBe(ERROR_BACKOFF_SCHEDULE_MS.length);
      expect(MAX_RETRIES).toBe(5);
    });
  });
});
