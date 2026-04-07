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
        providerName: 'ollama_cloud',
        providerProfileName: 'ollama-cloud-general',
        model: 'gpt-5.4',
        tier: 'external',
        usedFallback: true,
        durationMs: 512,
        usage: {
          promptTokens: 800,
          completionTokens: 120,
          totalTokens: 920,
          cacheCreationTokens: 400,
        },
      },
    })).toEqual({
      locality: 'external',
      providerName: 'ollama_cloud',
      providerProfileName: 'ollama-cloud-general',
      providerTier: 'managed_cloud',
      model: 'gpt-5.4',
      tier: 'external',
      usedFallback: true,
      notice: undefined,
      durationMs: 512,
      usage: {
        promptTokens: 800,
        completionTokens: 120,
        totalTokens: 920,
        cacheCreationTokens: 400,
      },
    });
  });

  it('formats response source labels compactly', () => {
    expect(formatResponseSourceLabel({
      responseSource: {
        locality: 'external',
        providerName: 'ollama_cloud',
        providerProfileName: 'ollama-cloud-general',
        providerTier: 'managed_cloud',
        usedFallback: true,
      },
    })).toBe('[managed cloud · ollama cloud · general · fallback]');
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
