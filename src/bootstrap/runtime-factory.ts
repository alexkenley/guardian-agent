import { dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { loadConfig } from '../config/loader.js';
import type { GuardianAgentConfig, WebSearchConfig } from '../config/types.js';
import { Runtime } from '../runtime/runtime.js';
import { resolveRuntimeCredentialView } from '../runtime/credentials.js';
import { LocalSecretStore } from '../runtime/secret-store.js';
import { ControlPlaneIntegrity } from '../guardian/control-plane-integrity.js';
import { buildPathBoundaryPattern } from '../util/regex.js';
import { setLogLevel } from '../util/logging.js';
import { mkdirSecureSync, tightenSecureTree, writeSecureFileSync } from '../util/secure-fs.js';

import { getGuardianBaseDir } from '../util/env.js';

export interface BootstrapRuntimeContext {
  configRef: { current: GuardianAgentConfig };
  config: GuardianAgentConfig;
  controlPlaneIntegrity: ControlPlaneIntegrity;
  guardianDataDir: string;
  resolvedRuntimeCredentials: ReturnType<typeof resolveRuntimeCredentialView>;
  runtime: Runtime;
  secretStore: LocalSecretStore;
  threatIntelWebSearchConfigRef: { current: WebSearchConfig | undefined };
}

const DEFAULT_BOOTSTRAP_CONFIG_YAML = [
  '# GuardianAgent Configuration',
  '# Docs: https://github.com/alexkenley/guardian-agent',
  '',
  'llm:',
  '  ollama:',
  '    provider: ollama',
  '    baseUrl: http://127.0.0.1:11434',
  '    model: gpt-oss:120b',
  '',
  '  # Uncomment to use Anthropic:',
  '  # claude:',
  '  #   provider: anthropic',
  '  #   apiKey: ${ANTHROPIC_API_KEY}',
  '  #   model: claude-sonnet-4-20250514',
  '',
  '  # Uncomment to use OpenAI:',
  '  # gpt:',
  '  #   provider: openai',
  '  #   apiKey: ${OPENAI_API_KEY}',
  '  #   model: gpt-4o',
  '',
  'defaultProvider: ollama',
  '',
  '# Fallback providers tried when the default fails (rate limit, timeout, etc.)',
  '# fallbacks:',
  '#   - claude',
  '',
  'channels:',
  '  cli:',
  '    enabled: true',
  '  telegram:',
  '    enabled: false',
  '  web:',
  '    enabled: true',
  '    port: 3000',
  '',
  'guardian:',
  '  enabled: true',
  '  logDenials: true',
  '',
  'runtime:',
  '  maxStallDurationMs: 60000',
  '  watchdogIntervalMs: 10000',
  '  logLevel: warn',
  '',
  'assistant:',
  '  soul:',
  '    enabled: true',
  '    path: SOUL.md',
  '    primaryMode: full',
  '    delegatedMode: summary',
  '    maxChars: 10000',
  '    summaryMaxChars: 1000',
  '  connectors:',
  '    enabled: false',
  '    executionMode: plan_then_execute',
  '    maxConnectorCallsPerRun: 12',
].join('\n') + '\n';

export function buildDefaultBootstrapConfigYaml(): string {
  return DEFAULT_BOOTSTRAP_CONFIG_YAML;
}

export function ensureGuardianDataDirDeniedPath(config: GuardianAgentConfig, guardianDataDir: string): void {
  const existing = config.guardian.deniedPaths ?? [];
  const absPattern = buildPathBoundaryPattern(guardianDataDir);
  if (!existing.includes(absPattern)) {
    config.guardian.deniedPaths = [...existing, absPattern];
  }
}

export function selectOllamaStartupModel(configuredModel: string, availableModels: string[]): string | null {
  if (availableModels.length === 0) return null;
  const modelFound = availableModels.some((model) =>
    model === configuredModel || model.startsWith(`${configuredModel}:`)
  );
  return modelFound ? null : availableModels[0] ?? null;
}

function logCreatedDefaultConfig(configPath: string): void {
  const isTTY = process.stdout.isTTY;
  const dim = (text: string) => isTTY ? `\x1b[2m${text}\x1b[0m` : text;
  const green = (text: string) => isTTY ? `\x1b[32m${text}\x1b[0m` : text;
  console.log(green(`  Created default config at ${configPath}`));
  console.log(dim('  Edit this file to configure LLM providers, channels, and security settings.'));
  console.log(dim('  Quick start: ensure Ollama is running, or set ANTHROPIC_API_KEY / OPENAI_API_KEY.'));
  console.log('');
}

async function ensureBootstrapConfigExists(
  configPath: string,
  controlPlaneIntegrity: ControlPlaneIntegrity,
): Promise<void> {
  if (existsSync(configPath)) {
    return;
  }
  mkdirSecureSync(dirname(configPath));
  writeSecureFileSync(configPath, buildDefaultBootstrapConfigYaml());
  controlPlaneIntegrity.signFileSync(configPath, 'config_bootstrap');
  logCreatedDefaultConfig(configPath);
}

async function autoRepairUnavailableOllamaModels(config: GuardianAgentConfig): Promise<void> {
  for (const [name, llmCfg] of Object.entries(config.llm)) {
    if (llmCfg.provider !== 'ollama') continue;
    const baseUrl = llmCfg.baseUrl || 'http://127.0.0.1:11434';
    try {
      const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) continue;
      const data = (await res.json()) as { models?: Array<{ name: string }> };
      const availableModels = data.models?.map((model) => model.name) ?? [];
      const selectedModel = selectOllamaStartupModel(llmCfg.model, availableModels);
      if (!selectedModel) continue;
      console.log(`  Ollama provider '${name}': model '${llmCfg.model}' not found. Auto-selecting '${selectedModel}'.`);
      (config.llm[name] as unknown as Record<string, unknown>).model = selectedModel;
    } catch {
      // Ollama not reachable — skip auto-detection
    }
  }
}

function applyRuntimeLogLevel(config: GuardianAgentConfig): void {
  if (process.env['LOG_LEVEL']) return;
  if (process.stdout.isTTY && !process.env['LOG_FILE']) {
    setLogLevel('silent');
    return;
  }
  setLogLevel(config.runtime.logLevel);
}

export async function createBootstrapRuntimeContext(configPath: string): Promise<BootstrapRuntimeContext> {
  const guardianDataDir = getGuardianBaseDir();
  const controlPlaneIntegrity = new ControlPlaneIntegrity({ baseDir: guardianDataDir });
  const configIntegrityState = controlPlaneIntegrity.verifyFileSync(configPath);
  if (!existsSync(configPath) && !configIntegrityState.ok) {
    throw new Error(configIntegrityState.message);
  }

  await ensureBootstrapConfigExists(configPath, controlPlaneIntegrity);
  await tightenSecureTree(guardianDataDir);

  const configRef = {
    current: loadConfig(configPath, {
      integrity: controlPlaneIntegrity,
      adoptUntrackedIntegrity: true,
    }),
  };
  ensureGuardianDataDirDeniedPath(configRef.current, guardianDataDir);

  const threatIntelWebSearchConfigRef: { current: WebSearchConfig | undefined } = { current: undefined };
  const secretStore = new LocalSecretStore({ baseDir: dirname(configPath) });

  await autoRepairUnavailableOllamaModels(configRef.current);

  const config = configRef.current;
  applyRuntimeLogLevel(config);

  const resolvedRuntimeCredentials = resolveRuntimeCredentialView(config, secretStore);
  for (const [name, llmCfg] of Object.entries(resolvedRuntimeCredentials.resolvedLLM)) {
    if (llmCfg.provider !== 'ollama' && !llmCfg.apiKey) {
      console.log(`  ⚠ LLM provider '${name}' started disconnected — credential could not be resolved`);
    }
  }

  threatIntelWebSearchConfigRef.current = resolvedRuntimeCredentials.resolvedWebSearch ?? {};
  const runtime = new Runtime({
    ...config,
    llm: resolvedRuntimeCredentials.resolvedLLM,
    assistant: {
      ...config.assistant,
      tools: {
        ...config.assistant.tools,
        cloud: resolvedRuntimeCredentials.resolvedCloud,
        webSearch: resolvedRuntimeCredentials.resolvedWebSearch,
      },
    },
  });

  return {
    configRef,
    config,
    controlPlaneIntegrity,
    guardianDataDir,
    resolvedRuntimeCredentials,
    runtime,
    secretStore,
    threatIntelWebSearchConfigRef,
  };
}
