import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type GuardianAgentConfig } from '../config/types.js';
import { buildPathBoundaryPattern } from '../util/regex.js';
import {
  buildDefaultBootstrapConfigYaml,
  ensureGuardianDataDirDeniedPath,
  selectOllamaStartupModel,
} from './runtime-factory.js';

describe('runtime bootstrap helpers', () => {
  it('builds the default bootstrap config yaml with expected starter sections', () => {
    const yaml = buildDefaultBootstrapConfigYaml();
    expect(yaml).toContain('defaultProvider: ollama');
    expect(yaml).toContain('channels:');
    expect(yaml).toContain('assistant:');
    expect(yaml.endsWith('\n')).toBe(true);
  });

  it('ensures the guardian data directory denied path is present once', () => {
    const config = structuredClone(DEFAULT_CONFIG) as GuardianAgentConfig;
    config.guardian.deniedPaths = [];

    ensureGuardianDataDirDeniedPath(config, '/home/alex/.guardianagent');
    ensureGuardianDataDirDeniedPath(config, '/home/alex/.guardianagent');

    expect(config.guardian.deniedPaths).toEqual([
      buildPathBoundaryPattern('/home/alex/.guardianagent'),
    ]);
  });

  it('keeps the configured Ollama model when an exact or tagged match exists', () => {
    expect(selectOllamaStartupModel('gpt-oss:120b', ['gpt-oss:120b', 'qwen2.5'])).toBeNull();
    expect(selectOllamaStartupModel('mistral', ['mistral:latest', 'gpt-oss:120b'])).toBeNull();
  });

  it('falls back to the first available Ollama model when the configured one is missing', () => {
    expect(selectOllamaStartupModel('missing-model', ['gpt-oss:120b', 'qwen2.5'])).toBe('gpt-oss:120b');
    expect(selectOllamaStartupModel('missing-model', [])).toBeNull();
  });
});
