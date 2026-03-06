/**
 * Configuration loader.
 *
 * Loads from ~/.guardianagent/config.yaml with ${ENV_VAR} interpolation,
 * deep-merges with defaults, and validates required fields.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import yaml from 'js-yaml';
import type { GuardianAgentConfig } from './types.js';
import { DEFAULT_CONFIG } from './types.js';
import { isValidTrustPreset, applyTrustPreset } from '../guardian/trust-presets.js';

/** Default config file path. */
export const DEFAULT_CONFIG_PATH = join(homedir(), '.guardianagent', 'config.yaml');

/** Interpolate ${ENV_VAR} references in a string. */
export function interpolateEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      throw new Error(`Environment variable '${varName}' is not set`);
    }
    return envValue;
  });
}

/** Recursively interpolate env vars in an object. */
function interpolateDeep(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return interpolateEnvVars(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(interpolateDeep);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = interpolateDeep(value);
    }
    return result;
  }
  return obj;
}

/** Deep merge source into target. Source values override target. */
export function deepMerge<T>(target: T, source: Partial<T>): T {
  const result = { ...target } as Record<string, unknown>;
  const src = source as Record<string, unknown>;
  const tgt = target as Record<string, unknown>;

  for (const key of Object.keys(src)) {
    const sourceVal = src[key];
    const targetVal = tgt[key];

    if (
      sourceVal !== null &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      targetVal !== null &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      );
    } else if (sourceVal !== undefined) {
      result[key] = sourceVal;
    }
  }

  return result as T;
}

/** Validate required configuration fields. */
export function validateConfig(config: GuardianAgentConfig): string[] {
  const errors: string[] = [];

  if (!config.defaultProvider) {
    errors.push('defaultProvider is required');
  }

  if (config.defaultProvider && !config.llm[config.defaultProvider]) {
    errors.push(`defaultProvider '${config.defaultProvider}' not found in llm configuration`);
  }

  for (const [name, llm] of Object.entries(config.llm)) {
    if (!llm.provider) {
      errors.push(`llm.${name}.provider is required`);
    }
    if (!['ollama', 'anthropic', 'openai'].includes(llm.provider)) {
      errors.push(`llm.${name}.provider must be 'ollama', 'anthropic', or 'openai'`);
    }
    if (!llm.model) {
      errors.push(`llm.${name}.model is required`);
    }
    if (llm.provider !== 'ollama' && !llm.apiKey) {
      errors.push(`llm.${name}.apiKey is required for provider '${llm.provider}'`);
    }
  }

  if (config.channels.telegram?.enabled && !config.channels.telegram.botToken) {
    errors.push('channels.telegram.botToken is required when Telegram is enabled');
  }

  if (!['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(config.runtime.logLevel)) {
    errors.push("runtime.logLevel must be one of: fatal, error, warn, info, debug, trace, silent");
  }

  const webAuth = config.channels.web?.auth;
  if (webAuth?.mode && webAuth.mode !== 'bearer_required') {
    errors.push("channels.web.auth.mode must be 'bearer_required'");
  }
  if (webAuth?.sessionTtlMinutes !== undefined && webAuth.sessionTtlMinutes < 1) {
    errors.push('channels.web.auth.sessionTtlMinutes must be >= 1');
  }

  const assistant = config.assistant;
  if (!assistant.identity.primaryUserId?.trim()) {
    errors.push('assistant.identity.primaryUserId is required');
  }

  if (!['single_user', 'channel_user'].includes(assistant.identity.mode)) {
    errors.push("assistant.identity.mode must be 'single_user' or 'channel_user'");
  }

  const soul = assistant.soul;
  if (soul.path !== undefined && !soul.path.trim()) {
    errors.push('assistant.soul.path must be a non-empty string when provided');
  }
  if (soul.maxChars < 256) {
    errors.push('assistant.soul.maxChars must be >= 256');
  }
  if (soul.summaryMaxChars < 64) {
    errors.push('assistant.soul.summaryMaxChars must be >= 64');
  }
  if (soul.summaryMaxChars > soul.maxChars) {
    errors.push('assistant.soul.summaryMaxChars must be <= assistant.soul.maxChars');
  }
  if (!['full', 'summary', 'disabled'].includes(soul.primaryMode)) {
    errors.push("assistant.soul.primaryMode must be 'full', 'summary', or 'disabled'");
  }
  if (!['full', 'summary', 'disabled'].includes(soul.delegatedMode)) {
    errors.push("assistant.soul.delegatedMode must be 'full', 'summary', or 'disabled'");
  }

  if (assistant.skills.enabled) {
    if (!Array.isArray(assistant.skills.roots) || assistant.skills.roots.length === 0) {
      errors.push('assistant.skills.roots must include at least one path when skills are enabled');
    }
    if (assistant.skills.maxActivePerRequest < 1) {
      errors.push('assistant.skills.maxActivePerRequest must be >= 1');
    }
  }

  if (assistant.memory.maxTurns < 1) {
    errors.push('assistant.memory.maxTurns must be >= 1');
  }
  if (assistant.memory.maxMessageChars < 1) {
    errors.push('assistant.memory.maxMessageChars must be >= 1');
  }
  if (assistant.memory.maxContextChars < 1) {
    errors.push('assistant.memory.maxContextChars must be >= 1');
  }
  if (assistant.memory.retentionDays < 1) {
    errors.push('assistant.memory.retentionDays must be >= 1');
  }
  if (assistant.analytics.retentionDays < 1) {
    errors.push('assistant.analytics.retentionDays must be >= 1');
  }

  if (assistant.quickActions.enabled && Object.keys(assistant.quickActions.templates).length === 0) {
    errors.push('assistant.quickActions.templates must contain at least one template when enabled');
  }

  if (!['approve_each', 'approve_by_policy', 'autonomous'].includes(assistant.tools.policyMode)) {
    errors.push("assistant.tools.policyMode must be 'approve_each', 'approve_by_policy', or 'autonomous'");
  }
  if (!Array.isArray(assistant.tools.allowedPaths) || assistant.tools.allowedPaths.length === 0) {
    errors.push('assistant.tools.allowedPaths must include at least one path');
  }
  if (!Array.isArray(assistant.tools.allowedCommands) || assistant.tools.allowedCommands.length === 0) {
    errors.push('assistant.tools.allowedCommands must include at least one command prefix');
  }
  if (!Array.isArray(assistant.tools.allowedDomains)) {
    errors.push('assistant.tools.allowedDomains must be an array');
  }
  for (const [toolName, decision] of Object.entries(assistant.tools.toolPolicies)) {
    if (!['auto', 'policy', 'manual', 'deny'].includes(decision)) {
      errors.push(`assistant.tools.toolPolicies.${toolName} must be auto, policy, manual, or deny`);
    }
  }

  const mcp = assistant.tools.mcp;
  if (mcp?.enabled) {
    const hasManagedProviders = !!mcp.managedProviders?.gws?.enabled;
    if ((!Array.isArray(mcp.servers) || mcp.servers.length === 0) && !hasManagedProviders) {
      errors.push('assistant.tools.mcp.servers must include at least one server or managed provider when MCP is enabled');
    } else if (Array.isArray(mcp.servers) && mcp.servers.length > 0) {
      const seenIds = new Set<string>();
      for (const server of mcp.servers) {
        if (!server.id?.trim()) {
          errors.push('assistant.tools.mcp server id is required');
        } else if (seenIds.has(server.id)) {
          errors.push(`assistant.tools.mcp server id '${server.id}' is duplicated`);
        } else {
          seenIds.add(server.id);
        }
        if (!server.name?.trim()) {
          errors.push(`assistant.tools.mcp server '${server.id || '(unnamed)'}' name is required`);
        }
        if (!server.command?.trim()) {
          errors.push(`assistant.tools.mcp server '${server.id || '(unnamed)'}' command is required`);
        }
        if (server.timeoutMs !== undefined && server.timeoutMs < 1000) {
          errors.push(`assistant.tools.mcp server '${server.id}' timeoutMs must be >= 1000`);
        }
      }
    }

    if (mcp.managedProviders?.gws?.enabled) {
      const gws = mcp.managedProviders.gws;
      if (gws.services && gws.services.some((value) => !value.trim())) {
        errors.push('assistant.tools.mcp.managedProviders.gws.services cannot contain empty values');
      }
      if (gws.timeoutMs !== undefined && gws.timeoutMs < 1000) {
        errors.push('assistant.tools.mcp.managedProviders.gws.timeoutMs must be >= 1000');
      }
      if (gws.accountMode && !['single_user', 'multi_account'].includes(gws.accountMode)) {
        errors.push("assistant.tools.mcp.managedProviders.gws.accountMode must be 'single_user' or 'multi_account'");
      }
    }
  }

  const threatIntel = assistant.threatIntel;
  if (!['manual', 'assisted', 'autonomous'].includes(threatIntel.responseMode)) {
    errors.push("assistant.threatIntel.responseMode must be 'manual', 'assisted', or 'autonomous'");
  }
  if (threatIntel.autoScanIntervalMinutes < 0) {
    errors.push('assistant.threatIntel.autoScanIntervalMinutes must be >= 0');
  }
  if (threatIntel.autoScanIntervalMinutes > 0 && threatIntel.autoScanIntervalMinutes < 5) {
    errors.push('assistant.threatIntel.autoScanIntervalMinutes must be >= 5 when enabled');
  }
  for (const target of threatIntel.watchlist) {
    if (!target.trim()) {
      errors.push('assistant.threatIntel.watchlist entries cannot be empty strings');
      break;
    }
  }

  const moltbook = threatIntel.moltbook;
  if (!['mock', 'api'].includes(moltbook.mode)) {
    errors.push("assistant.threatIntel.moltbook.mode must be 'mock' or 'api'");
  }
  if (moltbook.requestTimeoutMs < 500) {
    errors.push('assistant.threatIntel.moltbook.requestTimeoutMs must be >= 500');
  }
  if (moltbook.maxPostsPerQuery < 1) {
    errors.push('assistant.threatIntel.moltbook.maxPostsPerQuery must be >= 1');
  }
  if (moltbook.maxResponseBytes < 4096) {
    errors.push('assistant.threatIntel.moltbook.maxResponseBytes must be >= 4096');
  }
  if (moltbook.allowedHosts.length === 0) {
    errors.push('assistant.threatIntel.moltbook.allowedHosts must include at least one host');
  }
  if (moltbook.mode === 'api' && moltbook.enabled) {
    if (!moltbook.baseUrl?.trim()) {
      errors.push('assistant.threatIntel.moltbook.baseUrl is required when Moltbook api mode is enabled');
    } else {
      try {
        const parsed = new URL(moltbook.baseUrl);
        const host = parsed.hostname.toLowerCase();
        const allowedHosts = moltbook.allowedHosts.map((value) => value.trim().toLowerCase());
        if (!allowedHosts.includes(host)) {
          errors.push(`assistant.threatIntel.moltbook.baseUrl host '${host}' is not in allowedHosts`);
        }
        const insecure = parsed.protocol !== 'https:' &&
          !(parsed.protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1'));
        if (insecure) {
          errors.push('assistant.threatIntel.moltbook.baseUrl must use https (or http for localhost)');
        }
      } catch {
        errors.push('assistant.threatIntel.moltbook.baseUrl must be a valid URL');
      }
    }
  }

  const network = assistant.network;
  if (!['bundled', 'remote'].includes(network.deviceIntelligence.ouiDatabase)) {
    errors.push("assistant.network.deviceIntelligence.ouiDatabase must be 'bundled' or 'remote'");
  }
  if (network.baseline.minSnapshotsForBaseline < 1) {
    errors.push('assistant.network.baseline.minSnapshotsForBaseline must be >= 1');
  }
  if (network.baseline.dedupeWindowMs < 1_000) {
    errors.push('assistant.network.baseline.dedupeWindowMs must be >= 1000');
  }
  if (network.fingerprinting.bannerTimeout < 500) {
    errors.push('assistant.network.fingerprinting.bannerTimeout must be >= 500');
  }
  if (network.fingerprinting.maxConcurrentPerDevice < 1) {
    errors.push('assistant.network.fingerprinting.maxConcurrentPerDevice must be >= 1');
  }
  if (!['auto', 'linux', 'macos', 'windows'].includes(network.wifi.platform)) {
    errors.push("assistant.network.wifi.platform must be 'auto', 'linux', 'macos', or 'windows'");
  }
  if (network.wifi.scanInterval < 30) {
    errors.push('assistant.network.wifi.scanInterval must be >= 30');
  }
  if (!['ss', 'conntrack', 'router-api'].includes(network.trafficAnalysis.dataSource)) {
    errors.push("assistant.network.trafficAnalysis.dataSource must be 'ss', 'conntrack', or 'router-api'");
  }
  if (network.trafficAnalysis.flowRetention < 60_000) {
    errors.push('assistant.network.trafficAnalysis.flowRetention must be >= 60000');
  }
  if (network.trafficAnalysis.threatRules.dataExfiltration.thresholdMB < 1) {
    errors.push('assistant.network.trafficAnalysis.threatRules.dataExfiltration.thresholdMB must be >= 1');
  }
  if (network.trafficAnalysis.threatRules.portScanning.portThreshold < 5) {
    errors.push('assistant.network.trafficAnalysis.threatRules.portScanning.portThreshold must be >= 5');
  }
  if (network.trafficAnalysis.threatRules.beaconing.minIntervals < 2) {
    errors.push('assistant.network.trafficAnalysis.threatRules.beaconing.minIntervals must be >= 2');
  }
  for (const connection of network.connections) {
    if (!connection.id?.trim()) {
      errors.push('assistant.network.connections[].id is required');
    }
    if (!['lan', 'wifi', 'vpn', 'remote'].includes(connection.type)) {
      errors.push(`assistant.network.connections.${connection.id || '(unnamed)'}.type is invalid`);
    }
    if (connection.type === 'wifi' && !connection.ssid?.trim()) {
      errors.push(`assistant.network.connections.${connection.id || '(unnamed)'} requires ssid for wifi type`);
    }
    if (connection.type === 'remote' && !connection.host?.trim()) {
      errors.push(`assistant.network.connections.${connection.id || '(unnamed)'} requires host for remote type`);
    }
  }

  const connectors = assistant.connectors;
  if (!['plan_then_execute', 'direct_execute'].includes(connectors.executionMode)) {
    errors.push("assistant.connectors.executionMode must be 'plan_then_execute' or 'direct_execute'");
  }
  if (connectors.maxConnectorCallsPerRun < 1) {
    errors.push('assistant.connectors.maxConnectorCallsPerRun must be >= 1');
  }
  if (connectors.enabled && connectors.packs.length === 0) {
    errors.push('assistant.connectors.packs must include at least one pack when connectors are enabled');
  }
  if (connectors.enabled && !connectors.packs.some((pack) => pack.enabled)) {
    errors.push('assistant.connectors requires at least one enabled pack when connectors are enabled');
  }

  const seenPackIds = new Set<string>();
  for (const pack of connectors.packs) {
    if (!pack.id?.trim()) {
      errors.push('assistant.connectors.pack id is required');
    } else if (seenPackIds.has(pack.id)) {
      errors.push(`assistant.connectors.pack id '${pack.id}' is duplicated`);
    } else {
      seenPackIds.add(pack.id);
    }
    if (!pack.name?.trim()) {
      errors.push(`assistant.connectors.pack '${pack.id || '(unnamed)'}' name is required`);
    }
    if (!['none', 'api_key', 'oauth2', 'certificate'].includes(pack.authMode)) {
      errors.push(`assistant.connectors.pack '${pack.id || '(unnamed)'}' authMode is invalid`);
    }
    if (pack.enabled && pack.allowedCapabilities.length === 0) {
      errors.push(`assistant.connectors.pack '${pack.id}' must include at least one allowedCapability when enabled`);
    }
    for (const capability of pack.allowedCapabilities) {
      if (!capability.trim()) {
        errors.push(`assistant.connectors.pack '${pack.id}' allowedCapabilities cannot contain empty values`);
        break;
      }
    }
    for (const host of pack.allowedHosts) {
      if (!host.trim()) {
        errors.push(`assistant.connectors.pack '${pack.id}' allowedHosts cannot contain empty values`);
        break;
      }
    }
    for (const path of pack.allowedPaths) {
      if (!path.trim()) {
        errors.push(`assistant.connectors.pack '${pack.id}' allowedPaths cannot contain empty values`);
        break;
      }
    }
    for (const command of pack.allowedCommands) {
      if (!command.trim()) {
        errors.push(`assistant.connectors.pack '${pack.id}' allowedCommands cannot contain empty values`);
        break;
      }
    }
  }

  const playbooks = connectors.playbooks;
  const seenPlaybookIds = new Set<string>();
  for (const playbook of playbooks.definitions) {
    if (!playbook.id?.trim()) {
      errors.push('assistant.connectors.playbooks.definition id is required');
    } else if (seenPlaybookIds.has(playbook.id)) {
      errors.push(`assistant.connectors.playbooks.definition id '${playbook.id}' is duplicated`);
    } else {
      seenPlaybookIds.add(playbook.id);
    }
    if (!playbook.name?.trim()) {
      errors.push(`assistant.connectors.playbook '${playbook.id || '(unnamed)'}' name is required`);
    }
    if (!['sequential', 'parallel'].includes(playbook.mode)) {
      errors.push(`assistant.connectors.playbook '${playbook.id || '(unnamed)'}' mode must be sequential or parallel`);
    }
    if (!Array.isArray(playbook.steps) || playbook.steps.length === 0) {
      errors.push(`assistant.connectors.playbook '${playbook.id || '(unnamed)'}' must include at least one step`);
      continue;
    }
    if (playbook.steps.length > playbooks.maxSteps) {
      errors.push(`assistant.connectors.playbook '${playbook.id}' exceeds maxSteps (${playbooks.maxSteps})`);
    }
    const seenStepIds = new Set<string>();
    for (const step of playbook.steps) {
      if (!step.id?.trim()) {
        errors.push(`assistant.connectors.playbook '${playbook.id}' step id is required`);
      } else if (seenStepIds.has(step.id)) {
        errors.push(`assistant.connectors.playbook '${playbook.id}' step id '${step.id}' is duplicated`);
      } else {
        seenStepIds.add(step.id);
      }
      if (!step.packId?.trim()) {
        errors.push(`assistant.connectors.playbook '${playbook.id}' step '${step.id || '(unnamed)'}' packId is required`);
      }
      if (!step.toolName?.trim()) {
        errors.push(`assistant.connectors.playbook '${playbook.id}' step '${step.id || '(unnamed)'}' toolName is required`);
      }
      if (step.timeoutMs !== undefined && step.timeoutMs < 1000) {
        errors.push(`assistant.connectors.playbook '${playbook.id}' step '${step.id}' timeoutMs must be >= 1000`);
      }
    }
  }
  if (playbooks.maxSteps < 1) {
    errors.push('assistant.connectors.playbooks.maxSteps must be >= 1');
  }
  if (playbooks.maxParallelSteps < 1) {
    errors.push('assistant.connectors.playbooks.maxParallelSteps must be >= 1');
  }
  if (playbooks.maxParallelSteps > playbooks.maxSteps) {
    errors.push('assistant.connectors.playbooks.maxParallelSteps must be <= assistant.connectors.playbooks.maxSteps');
  }
  if (playbooks.defaultStepTimeoutMs < 1000) {
    errors.push('assistant.connectors.playbooks.defaultStepTimeoutMs must be >= 1000');
  }

  const studio = connectors.studio;
  if (!['read_only', 'builder'].includes(studio.mode)) {
    errors.push("assistant.connectors.studio.mode must be 'read_only' or 'builder'");
  }

  return errors;
}

/** Load configuration from a YAML file path. */
export function loadConfigFromFile(filePath: string): GuardianAgentConfig {
  if (!existsSync(filePath)) {
    throw new Error(`Configuration file not found: ${filePath}`);
  }

  const raw = readFileSync(filePath, 'utf-8');
  const parsed = yaml.load(raw) as Partial<GuardianAgentConfig> | null;

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid configuration file: ${filePath}`);
  }

  const interpolated = interpolateDeep(parsed) as Partial<GuardianAgentConfig>;
  let merged = deepMerge(DEFAULT_CONFIG, interpolated);

  // Apply trust preset if configured (preset overrides defaults, user's explicit values override preset)
  const presetName = merged.guardian?.trustPreset;
  if (presetName && isValidTrustPreset(presetName)) {
    merged = applyTrustPreset(presetName, merged);
    // Re-apply user's explicit overrides so they win over preset values
    if (interpolated.guardian) {
      merged.guardian = deepMerge(merged.guardian, interpolated.guardian as Partial<typeof merged.guardian>);
    }
    if (interpolated.assistant?.tools && 'policyMode' in interpolated.assistant.tools) {
      merged.assistant = {
        ...merged.assistant,
        tools: {
          ...merged.assistant.tools,
          policyMode: (interpolated.assistant.tools as { policyMode: string }).policyMode as typeof merged.assistant.tools.policyMode,
        },
      };
    }
  }

  // Backward compatibility: legacy auth modes were removed; enforce strict bearer auth.
  if (merged.channels.web?.auth?.mode && merged.channels.web.auth.mode !== 'bearer_required') {
    merged.channels.web.auth.mode = 'bearer_required';
  }

  const errors = validateConfig(merged);
  if (errors.length > 0) {
    throw new Error(`Configuration validation failed:\n  - ${errors.join('\n  - ')}`);
  }

  return merged;
}

/** Load configuration with fallback to defaults. */
export function loadConfig(filePath?: string): GuardianAgentConfig {
  const path = filePath ?? DEFAULT_CONFIG_PATH;

  if (!existsSync(path)) {
    // No config file — return defaults
    return { ...DEFAULT_CONFIG };
  }

  return loadConfigFromFile(path);
}
