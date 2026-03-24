import { describe, expect, it } from 'vitest';
import {
  buildLocalModelTooComplicatedMessage,
  formatResponseSourceLabel,
  isLocalToolCallParseError,
  readResponseSourceMetadata,
  shouldBypassLocalModelComplexityGuard,
} from './model-routing-ux.js';

describe('model-routing-ux', () => {
  it('detects Ollama tool-call parsing failures', () => {
    expect(
      isLocalToolCallParseError(
        new Error('Ollama API error 500: {"error":{"message":"error parsing tool call: raw=\'{...}\', err=unexpected end of JSON input"}}'),
      ),
    ).toBe(true);
  });

  it('reads response source metadata', () => {
    expect(readResponseSourceMetadata({
      responseSource: {
        locality: 'external',
        providerName: 'openai',
        tier: 'external',
        usedFallback: true,
      },
    })).toEqual({
      locality: 'external',
      providerName: 'openai',
      tier: 'external',
      usedFallback: true,
      notice: undefined,
    });
  });

  it('formats response source labels compactly', () => {
    expect(formatResponseSourceLabel({
      responseSource: { locality: 'external', usedFallback: true },
    })).toBe('[external · fallback]');
  });

  it('returns the friendly local-model complexity message', () => {
    expect(buildLocalModelTooComplicatedMessage()).toContain('Please change model or configure external');
  });

  it('supports bypassing the friendly local-model complexity guard via env', () => {
    expect(shouldBypassLocalModelComplexityGuard({
      GUARDIAN_BYPASS_LOCAL_MODEL_COMPLEXITY_GUARD: '1',
    })).toBe(true);
    expect(shouldBypassLocalModelComplexityGuard({
      GUARDIAN_BYPASS_LOCAL_MODEL_COMPLEXITY_GUARD: 'true',
    })).toBe(true);
    expect(shouldBypassLocalModelComplexityGuard({
      GUARDIAN_BYPASS_LOCAL_MODEL_COMPLEXITY_GUARD: '0',
    })).toBe(false);
  });
});
