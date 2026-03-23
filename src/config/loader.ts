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
import type { ControlPlaneIntegrity } from '../guardian/control-plane-integrity.js';
import { enforceSecurityBaseline, logSecurityBaselineEnforcement } from '../guardian/security-baseline.js';
import { ProviderRegistry } from '../llm/provider-registry.js';
import { normalizeCpanelConnectionConfig } from '../tools/cloud/cpanel-profile.js';
import { normalizeConfigInputs, normalizeHttpUrlInput } from './input-normalization.js';
import {
  isAssistantSecurityAutoContainmentCategory,
  isAssistantSecurityAutoContainmentSeverity,
  isAssistantSecurityMonitoringProfile,
  isDeploymentProfile,
  isSecurityOperatingMode,
  isSecurityTriageLlmProvider,
} from '../runtime/security-controls.js';

const SUPPORTED_LLM_PROVIDERS = new Set(new ProviderRegistry().listProviderNames());
const SUPPORTED_LLM_PROVIDER_LIST = [...SUPPORTED_LLM_PROVIDERS].join(', ');

function isLocalLLMConfig(provider: string | undefined, baseUrl: string | undefined): boolean {
  if ((provider ?? '').trim().toLowerCase() === 'ollama') return true;
  if (!baseUrl?.trim()) return false;
  try {
    const host = new URL(baseUrl).hostname.trim().toLowerCase();
    return host === 'localhost'
      || host === '127.0.0.1'
      || host === '::1'
      || host.endsWith('.local');
  } catch {
    return false;
  }
}

/** Default config file path. */
export const DEFAULT_CONFIG_PATH = join(homedir(), '.guardianagent', 'config.yaml');

/** Interpolate ${ENV_VAR} references in a string. */
export function interpolateEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
    // Preserve runtime template placeholders such as ${step2.output} that are
    // used inside automation/playbook definitions. Environment variable names
    // with dots are not portable shell env vars and should not be expanded here.
    if (varName.includes('.')) {
      return `\${${varName}}`;
    }
    const envValue = process.env[varName];
    // Preserve incidental template placeholders from saved automation content
    // unless they match the normal ${ENV_VAR} config pattern or the env exists.
    if (envValue === undefined && !/^[A-Z_][A-Z0-9_]*$/.test(varName)) {
      return `\${${varName}}`;
    }
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
  const credentialRefs = config.assistant.credentials.refs;

  /**
   * Validate a credential ref pointer.
   *
   * Ref entries in assistant.credentials.refs are NOT required to exist at validation
   * time. Auto-managed local refs are created at runtime when secrets are stored and
   * may not be present in the YAML config. What we validate:
   *  - If a value is provided it must be a non-empty string.
   *  - If `warnMissing` is true we still allow startup but log the dangling pointer
   *    (callers can use the returned boolean to add their own warning if desired).
   */
  const assertCredentialRef = (value: string | undefined, path: string): void => {
    if (value === undefined) return;
    const ref = value.trim();
    if (!ref) {
      errors.push(`${path} must be a non-empty string when provided`);
    }
  };

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
    if (!SUPPORTED_LLM_PROVIDERS.has(llm.provider)) {
      errors.push(`llm.${name}.provider must be one of: ${SUPPORTED_LLM_PROVIDER_LIST}`);
    }
    if (!llm.model) {
      errors.push(`llm.${name}.model is required`);
    }
    if (llm.apiKey?.trim()) {
      errors.push(`llm.${name}.apiKey is not allowed in config. Use llm.${name}.credentialRef with assistant.credentials.refs instead.`);
    }
    assertCredentialRef(llm.credentialRef, `llm.${name}.credentialRef`);
    if (llm.provider !== 'ollama' && !llm.credentialRef) {
      errors.push(`llm.${name}.credentialRef is required for provider '${llm.provider}'`);
    }
    if (llm.baseUrl?.trim()) {
      try {
        normalizeHttpUrlInput(llm.baseUrl);
      } catch (error) {
        errors.push(`llm.${name}.baseUrl ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const preferredProviders = config.assistant.tools.preferredProviders;
  if (preferredProviders?.local?.trim()) {
    const providerName = preferredProviders.local.trim();
    const provider = config.llm[providerName];
    if (!provider) {
      errors.push(`assistant.tools.preferredProviders.local references unknown provider '${providerName}'`);
    } else if (!isLocalLLMConfig(provider.provider, provider.baseUrl)) {
      errors.push(`assistant.tools.preferredProviders.local must reference a local provider, got '${providerName}'`);
    }
  }
  if (preferredProviders?.external?.trim()) {
    const providerName = preferredProviders.external.trim();
    const provider = config.llm[providerName];
    if (!provider) {
      errors.push(`assistant.tools.preferredProviders.external references unknown provider '${providerName}'`);
    } else if (isLocalLLMConfig(provider.provider, provider.baseUrl)) {
      errors.push(`assistant.tools.preferredProviders.external must reference an external provider, got '${providerName}'`);
    }
  }

  if (config.channels.telegram?.botToken?.trim()) {
    errors.push('channels.telegram.botToken is not allowed in config. Use channels.telegram.botTokenCredentialRef with assistant.credentials.refs instead.');
  }
  assertCredentialRef(config.channels.telegram?.botTokenCredentialRef, 'channels.telegram.botTokenCredentialRef');
  if (config.channels.telegram?.enabled && !config.channels.telegram.botTokenCredentialRef) {
    errors.push('channels.telegram.botTokenCredentialRef is required when Telegram is enabled');
  }

  if (!['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(config.runtime.logLevel)) {
    errors.push("runtime.logLevel must be one of: fatal, error, warn, info, debug, trace, silent");
  }

  const piiRedaction = config.guardian?.piiRedaction;
  const validPiiEntities = new Set([
    'email',
    'ssn',
    'credit_card',
    'phone',
    'street_address',
    'date_of_birth',
    'medical_record_number',
    'passport',
    'drivers_license',
  ]);
  if (piiRedaction?.mode && !['redact', 'anonymize'].includes(piiRedaction.mode)) {
    errors.push("guardian.piiRedaction.mode must be 'redact' or 'anonymize'");
  }
  if (piiRedaction?.providerScope && !['all', 'external'].includes(piiRedaction.providerScope)) {
    errors.push("guardian.piiRedaction.providerScope must be 'all' or 'external'");
  }
  if (piiRedaction?.entities) {
    for (const entity of piiRedaction.entities) {
      if (!validPiiEntities.has(entity)) {
        errors.push(`guardian.piiRedaction.entities contains unknown entity '${entity}'`);
      }
    }
  }

  const webAuth = config.channels.web?.auth;
  if (webAuth?.mode && webAuth.mode !== 'bearer_required') {
    errors.push("channels.web.auth.mode must be 'bearer_required'");
  }
  if (webAuth?.sessionTtlMinutes !== undefined && webAuth.sessionTtlMinutes < 1) {
    errors.push('channels.web.auth.sessionTtlMinutes must be >= 1');
  }
  if (config.channels.web?.enabled && config.channels.web.allowedOrigins?.includes('*')) {
    errors.push("channels.web.allowedOrigins must not contain '*' because the web API is auth-protected and served on localhost");
  }

  const assistant = config.assistant;
  for (const [name, ref] of Object.entries(credentialRefs)) {
    if (!name.trim()) {
      errors.push('assistant.credentials.refs keys must be non-empty');
    }
    if (!['env', 'local'].includes(ref.source)) {
      errors.push(`assistant.credentials.refs.${name}.source must be 'env' or 'local'`);
    }
    if (ref.source === 'env' && !ref.env?.trim()) {
      errors.push(`assistant.credentials.refs.${name}.env is required`);
    }
    if (ref.source === 'local' && !ref.secretId?.trim()) {
      errors.push(`assistant.credentials.refs.${name}.secretId is required`);
    }
  }
  if (!assistant.identity.primaryUserId?.trim()) {
    errors.push('assistant.identity.primaryUserId is required');
  }

  if (!['single_user', 'channel_user'].includes(assistant.identity.mode)) {
    errors.push("assistant.identity.mode must be 'single_user' or 'channel_user'");
  }

  if (assistant.security?.deploymentProfile && !isDeploymentProfile(assistant.security.deploymentProfile)) {
    errors.push("assistant.security.deploymentProfile must be one of: personal, home, organization");
  }
  if (assistant.security?.operatingMode && !isSecurityOperatingMode(assistant.security.operatingMode)) {
    errors.push("assistant.security.operatingMode must be one of: monitor, guarded, lockdown, ir_assist");
  }
  if (
    assistant.security?.triageLlmProvider
    && !isSecurityTriageLlmProvider(assistant.security.triageLlmProvider)
  ) {
    errors.push("assistant.security.triageLlmProvider must be one of: auto, local, external");
  }
  if (assistant.security?.continuousMonitoring) {
    const monitoring = assistant.security.continuousMonitoring;
    if (typeof monitoring.enabled !== 'boolean') {
      errors.push('assistant.security.continuousMonitoring.enabled must be a boolean');
    }
    if (!isAssistantSecurityMonitoringProfile(monitoring.profileId)) {
      errors.push('assistant.security.continuousMonitoring.profileId must be one of: quick, runtime-hardening, workspace-boundaries');
    }
    if (!monitoring.cron?.trim()) {
      errors.push('assistant.security.continuousMonitoring.cron is required');
    }
  }
  if (assistant.security?.autoContainment) {
    const autoContainment = assistant.security.autoContainment;
    if (typeof autoContainment.enabled !== 'boolean') {
      errors.push('assistant.security.autoContainment.enabled must be a boolean');
    }
    if (!isAssistantSecurityAutoContainmentSeverity(autoContainment.minSeverity)) {
      errors.push('assistant.security.autoContainment.minSeverity must be one of: high, critical');
    }
    if (!Number.isFinite(autoContainment.minConfidence) || autoContainment.minConfidence < 0 || autoContainment.minConfidence > 1) {
      errors.push('assistant.security.autoContainment.minConfidence must be between 0 and 1');
    }
    if (!Array.isArray(autoContainment.categories)) {
      errors.push('assistant.security.autoContainment.categories must be an array');
    } else {
      for (const category of autoContainment.categories) {
        if (!isAssistantSecurityAutoContainmentCategory(category)) {
          errors.push(`assistant.security.autoContainment.categories contains unknown category '${category}'`);
        }
      }
    }
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
  const knowledgeBase = assistant.memory.knowledgeBase ?? {
    enabled: true,
    readOnly: false,
    maxContextChars: 4000,
    maxFileChars: 20000,
    maxEntryChars: 2000,
    maxEntriesPerScope: 500,
    maxEmbeddingCacheBytes: 50_000_000,
    autoFlush: true,
  };
  if (knowledgeBase.maxContextChars < 1) {
    errors.push('assistant.memory.knowledgeBase.maxContextChars must be >= 1');
  }
  if (knowledgeBase.maxFileChars < 1) {
    errors.push('assistant.memory.knowledgeBase.maxFileChars must be >= 1');
  }
  if (knowledgeBase.maxEntryChars < 1) {
    errors.push('assistant.memory.knowledgeBase.maxEntryChars must be >= 1');
  }
  if (knowledgeBase.maxEntriesPerScope < 1) {
    errors.push('assistant.memory.knowledgeBase.maxEntriesPerScope must be >= 1');
  }
  if (knowledgeBase.maxEmbeddingCacheBytes < 0) {
    errors.push('assistant.memory.knowledgeBase.maxEmbeddingCacheBytes must be >= 0');
  }
  if (knowledgeBase.maxContextChars > knowledgeBase.maxFileChars) {
    errors.push('assistant.memory.knowledgeBase.maxContextChars must be <= assistant.memory.knowledgeBase.maxFileChars');
  }
  if (knowledgeBase.maxEntryChars > knowledgeBase.maxFileChars) {
    errors.push('assistant.memory.knowledgeBase.maxEntryChars must be <= assistant.memory.knowledgeBase.maxFileChars');
  }
  if (assistant.analytics.retentionDays < 1) {
    errors.push('assistant.analytics.retentionDays must be >= 1');
  }
  if (!['info', 'warn', 'critical'].includes(assistant.notifications.minSeverity)) {
    errors.push("assistant.notifications.minSeverity must be 'info', 'warn', or 'critical'");
  }
  if (!['all', 'selected'].includes(assistant.notifications.deliveryMode)) {
    errors.push("assistant.notifications.deliveryMode must be 'all' or 'selected'");
  }
  if (assistant.notifications.cooldownMs < 0) {
    errors.push('assistant.notifications.cooldownMs must be >= 0');
  }
  const validNotificationAuditTypes = new Set([
    'action_denied',
    'action_allowed',
    'secret_detected',
    'output_blocked',
    'output_redacted',
    'event_blocked',
    'input_sanitized',
    'rate_limited',
    'capability_probe',
    'policy_changed',
    'anomaly_detected',
    'host_alert',
    'gateway_alert',
    'agent_error',
    'agent_stalled',
    'policy_engine_started',
    'policy_mode_changed',
    'policy_rules_reloaded',
    'policy_shadow_mismatch',
    'automation_finding',
    'auth_failure',
  ]);
  for (const eventType of assistant.notifications.auditEventTypes ?? []) {
    if (!validNotificationAuditTypes.has(eventType)) {
      errors.push(`assistant.notifications.auditEventTypes contains unknown event '${eventType}'`);
    }
  }
  for (const detailType of assistant.notifications.suppressedDetailTypes ?? []) {
    if (typeof detailType !== 'string' || !detailType.trim()) {
      errors.push('assistant.notifications.suppressedDetailTypes must contain only non-empty strings');
      break;
    }
  }
  if (assistant.hostMonitoring.scanIntervalSec < 10) {
    errors.push('assistant.hostMonitoring.scanIntervalSec must be >= 10');
  }
  if (assistant.hostMonitoring.dedupeWindowMs < 0) {
    errors.push('assistant.hostMonitoring.dedupeWindowMs must be >= 0');
  }
  for (const path of assistant.hostMonitoring.sensitivePaths ?? []) {
    if (typeof path !== 'string' || !path.trim()) {
      errors.push('assistant.hostMonitoring.sensitivePaths must contain only non-empty strings');
      break;
    }
  }
  for (const name of assistant.hostMonitoring.suspiciousProcessNames ?? []) {
    if (typeof name !== 'string' || !name.trim()) {
      errors.push('assistant.hostMonitoring.suspiciousProcessNames must contain only non-empty strings');
      break;
    }
  }
  if (assistant.gatewayMonitoring.scanIntervalSec < 10) {
    errors.push('assistant.gatewayMonitoring.scanIntervalSec must be >= 10');
  }
  if (assistant.gatewayMonitoring.dedupeWindowMs < 0) {
    errors.push('assistant.gatewayMonitoring.dedupeWindowMs must be >= 0');
  }
  for (const monitor of assistant.gatewayMonitoring.monitors ?? []) {
    if (!monitor.id?.trim()) {
      errors.push('assistant.gatewayMonitoring.monitors[].id is required');
      break;
    }
    if (!monitor.displayName?.trim()) {
      errors.push(`assistant.gatewayMonitoring.monitors['${monitor.id || '?'}'].displayName is required`);
      break;
    }
    if (!['generic_json', 'opnsense', 'pfsense', 'unifi'].includes(monitor.provider)) {
      errors.push(`assistant.gatewayMonitoring.monitors['${monitor.id || '?'}'].provider must be generic_json, opnsense, pfsense, or unifi`);
      break;
    }
    if (!monitor.command?.trim()) {
      errors.push(`assistant.gatewayMonitoring.monitors['${monitor.id || '?'}'].command is required`);
      break;
    }
    if (!Array.isArray(monitor.args)) {
      errors.push(`assistant.gatewayMonitoring.monitors['${monitor.id || '?'}'].args must be an array`);
      break;
    }
    if (monitor.timeoutMs < 1000) {
      errors.push(`assistant.gatewayMonitoring.monitors['${monitor.id || '?'}'].timeoutMs must be >= 1000`);
      break;
    }
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
  assertCredentialRef(assistant.tools.webSearch?.braveCredentialRef, 'assistant.tools.webSearch.braveCredentialRef');
  assertCredentialRef(assistant.tools.webSearch?.perplexityCredentialRef, 'assistant.tools.webSearch.perplexityCredentialRef');
  assertCredentialRef(assistant.tools.webSearch?.openRouterCredentialRef, 'assistant.tools.webSearch.openRouterCredentialRef');
  if (assistant.tools.webSearch?.braveApiKey?.trim()) {
    errors.push('assistant.tools.webSearch.braveApiKey is not allowed in config. Use assistant.tools.webSearch.braveCredentialRef with assistant.credentials.refs instead.');
  }
  if (assistant.tools.webSearch?.perplexityApiKey?.trim()) {
    errors.push('assistant.tools.webSearch.perplexityApiKey is not allowed in config. Use assistant.tools.webSearch.perplexityCredentialRef with assistant.credentials.refs instead.');
  }
  if (assistant.tools.webSearch?.openRouterApiKey?.trim()) {
    errors.push('assistant.tools.webSearch.openRouterApiKey is not allowed in config. Use assistant.tools.webSearch.openRouterCredentialRef with assistant.credentials.refs instead.');
  }
  const cloud = assistant.tools.cloud;
  if (cloud) {
    const seenProfileIds = new Set<string>();
    for (const profile of cloud.cpanelProfiles ?? []) {
      if (!profile.id?.trim()) {
        errors.push('assistant.tools.cloud.cpanelProfiles.id is required');
      } else if (seenProfileIds.has(profile.id)) {
        errors.push(`assistant.tools.cloud.cpanelProfiles id '${profile.id}' is duplicated`);
      } else {
        seenProfileIds.add(profile.id);
      }
      if (!profile.name?.trim()) {
        errors.push(`assistant.tools.cloud.cpanelProfiles.${profile.id || '(unnamed)'}.name is required`);
      }
      if (!['cpanel', 'whm'].includes(profile.type)) {
        errors.push(`assistant.tools.cloud.cpanelProfiles.${profile.id || '(unnamed)'}.type must be 'cpanel' or 'whm'`);
      }
      if (!profile.host?.trim()) {
        errors.push(`assistant.tools.cloud.cpanelProfiles.${profile.id || '(unnamed)'}.host is required`);
      } else {
        try {
          normalizeCpanelConnectionConfig({
            host: profile.host,
            port: profile.port,
            ssl: profile.ssl,
          });
        } catch (error) {
          errors.push(
            `assistant.tools.cloud.cpanelProfiles.${profile.id || '(unnamed)'}.host ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (!profile.username?.trim()) {
        errors.push(`assistant.tools.cloud.cpanelProfiles.${profile.id || '(unnamed)'}.username is required`);
      }
      if (!profile.apiToken?.trim() && !profile.credentialRef?.trim()) {
        errors.push(`assistant.tools.cloud.cpanelProfiles.${profile.id || '(unnamed)'}.apiToken or credentialRef is required`);
      }
      if (profile.port !== undefined && (profile.port < 1 || profile.port > 65535)) {
        errors.push(`assistant.tools.cloud.cpanelProfiles.${profile.id || '(unnamed)'}.port must be between 1 and 65535`);
      }
      assertCredentialRef(
        profile.credentialRef,
        `assistant.tools.cloud.cpanelProfiles.${profile.id || '(unnamed)'}.credentialRef`,
      );
    }
    const seenVercelProfileIds = new Set<string>();
    for (const profile of cloud.vercelProfiles ?? []) {
      if (!profile.id?.trim()) {
        errors.push('assistant.tools.cloud.vercelProfiles.id is required');
      } else if (seenVercelProfileIds.has(profile.id)) {
        errors.push(`assistant.tools.cloud.vercelProfiles id '${profile.id}' is duplicated`);
      } else {
        seenVercelProfileIds.add(profile.id);
      }
      if (!profile.name?.trim()) {
        errors.push(`assistant.tools.cloud.vercelProfiles.${profile.id || '(unnamed)'}.name is required`);
      }
      if (!profile.apiToken?.trim() && !profile.credentialRef?.trim()) {
        errors.push(`assistant.tools.cloud.vercelProfiles.${profile.id || '(unnamed)'}.apiToken or credentialRef is required`);
      }
      if (profile.teamId?.trim() && profile.slug?.trim()) {
        errors.push(`assistant.tools.cloud.vercelProfiles.${profile.id || '(unnamed)'}.teamId and slug are mutually exclusive`);
      }
      if (profile.apiBaseUrl?.trim()) {
        try {
          normalizeHttpUrlInput(profile.apiBaseUrl);
        } catch (error) {
          errors.push(`assistant.tools.cloud.vercelProfiles.${profile.id || '(unnamed)'}.apiBaseUrl ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      assertCredentialRef(
        profile.credentialRef,
        `assistant.tools.cloud.vercelProfiles.${profile.id || '(unnamed)'}.credentialRef`,
      );
    }
    const seenCloudflareProfileIds = new Set<string>();
    for (const profile of cloud.cloudflareProfiles ?? []) {
      if (!profile.id?.trim()) {
        errors.push('assistant.tools.cloud.cloudflareProfiles.id is required');
      } else if (seenCloudflareProfileIds.has(profile.id)) {
        errors.push(`assistant.tools.cloud.cloudflareProfiles id '${profile.id}' is duplicated`);
      } else {
        seenCloudflareProfileIds.add(profile.id);
      }
      if (!profile.name?.trim()) {
        errors.push(`assistant.tools.cloud.cloudflareProfiles.${profile.id || '(unnamed)'}.name is required`);
      }
      if (!profile.apiToken?.trim() && !profile.credentialRef?.trim()) {
        errors.push(`assistant.tools.cloud.cloudflareProfiles.${profile.id || '(unnamed)'}.apiToken or credentialRef is required`);
      }
      if (profile.apiBaseUrl?.trim()) {
        try {
          normalizeHttpUrlInput(profile.apiBaseUrl);
        } catch (error) {
          errors.push(`assistant.tools.cloud.cloudflareProfiles.${profile.id || '(unnamed)'}.apiBaseUrl ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      assertCredentialRef(
        profile.credentialRef,
        `assistant.tools.cloud.cloudflareProfiles.${profile.id || '(unnamed)'}.credentialRef`,
      );
    }
    const seenAwsProfileIds = new Set<string>();
    for (const profile of cloud.awsProfiles ?? []) {
      if (!profile.id?.trim()) {
        errors.push('assistant.tools.cloud.awsProfiles.id is required');
      } else if (seenAwsProfileIds.has(profile.id)) {
        errors.push(`assistant.tools.cloud.awsProfiles id '${profile.id}' is duplicated`);
      } else {
        seenAwsProfileIds.add(profile.id);
      }
      if (!profile.name?.trim()) {
        errors.push(`assistant.tools.cloud.awsProfiles.${profile.id || '(unnamed)'}.name is required`);
      }
      if (!profile.region?.trim()) {
        errors.push(`assistant.tools.cloud.awsProfiles.${profile.id || '(unnamed)'}.region is required`);
      }
      const hasAccessKey = !!profile.accessKeyId?.trim() || !!profile.accessKeyIdCredentialRef?.trim();
      const hasSecretKey = !!profile.secretAccessKey?.trim() || !!profile.secretAccessKeyCredentialRef?.trim();
      if (hasAccessKey !== hasSecretKey) {
        errors.push(`assistant.tools.cloud.awsProfiles.${profile.id || '(unnamed)'}.accessKeyId and secretAccessKey must be provided together`);
      }
      assertCredentialRef(
        profile.accessKeyIdCredentialRef,
        `assistant.tools.cloud.awsProfiles.${profile.id || '(unnamed)'}.accessKeyIdCredentialRef`,
      );
      assertCredentialRef(
        profile.secretAccessKeyCredentialRef,
        `assistant.tools.cloud.awsProfiles.${profile.id || '(unnamed)'}.secretAccessKeyCredentialRef`,
      );
      assertCredentialRef(
        profile.sessionTokenCredentialRef,
        `assistant.tools.cloud.awsProfiles.${profile.id || '(unnamed)'}.sessionTokenCredentialRef`,
      );
      for (const [service, endpoint] of Object.entries(profile.endpoints ?? {})) {
        if (!endpoint?.trim()) continue;
        try {
          normalizeHttpUrlInput(endpoint);
        } catch (error) {
          errors.push(`assistant.tools.cloud.awsProfiles.${profile.id || '(unnamed)'}.endpoints.${service} ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    const seenGcpProfileIds = new Set<string>();
    for (const profile of cloud.gcpProfiles ?? []) {
      if (!profile.id?.trim()) {
        errors.push('assistant.tools.cloud.gcpProfiles.id is required');
      } else if (seenGcpProfileIds.has(profile.id)) {
        errors.push(`assistant.tools.cloud.gcpProfiles id '${profile.id}' is duplicated`);
      } else {
        seenGcpProfileIds.add(profile.id);
      }
      if (!profile.name?.trim()) {
        errors.push(`assistant.tools.cloud.gcpProfiles.${profile.id || '(unnamed)'}.name is required`);
      }
      if (!profile.projectId?.trim()) {
        errors.push(`assistant.tools.cloud.gcpProfiles.${profile.id || '(unnamed)'}.projectId is required`);
      }
      const hasAccessToken = !!profile.accessToken?.trim() || !!profile.accessTokenCredentialRef?.trim();
      const hasServiceAccount = !!profile.serviceAccountJson?.trim() || !!profile.serviceAccountCredentialRef?.trim();
      if (!hasAccessToken && !hasServiceAccount) {
        errors.push(`assistant.tools.cloud.gcpProfiles.${profile.id || '(unnamed)'}.accessToken/accessTokenCredentialRef or serviceAccountJson/serviceAccountCredentialRef is required`);
      }
      assertCredentialRef(
        profile.accessTokenCredentialRef,
        `assistant.tools.cloud.gcpProfiles.${profile.id || '(unnamed)'}.accessTokenCredentialRef`,
      );
      assertCredentialRef(
        profile.serviceAccountCredentialRef,
        `assistant.tools.cloud.gcpProfiles.${profile.id || '(unnamed)'}.serviceAccountCredentialRef`,
      );
      for (const [service, endpoint] of Object.entries(profile.endpoints ?? {})) {
        if (!endpoint?.trim()) continue;
        try {
          normalizeHttpUrlInput(endpoint);
        } catch (error) {
          errors.push(`assistant.tools.cloud.gcpProfiles.${profile.id || '(unnamed)'}.endpoints.${service} ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    const seenAzureProfileIds = new Set<string>();
    for (const profile of cloud.azureProfiles ?? []) {
      if (!profile.id?.trim()) {
        errors.push('assistant.tools.cloud.azureProfiles.id is required');
      } else if (seenAzureProfileIds.has(profile.id)) {
        errors.push(`assistant.tools.cloud.azureProfiles id '${profile.id}' is duplicated`);
      } else {
        seenAzureProfileIds.add(profile.id);
      }
      if (!profile.name?.trim()) {
        errors.push(`assistant.tools.cloud.azureProfiles.${profile.id || '(unnamed)'}.name is required`);
      }
      if (!profile.subscriptionId?.trim()) {
        errors.push(`assistant.tools.cloud.azureProfiles.${profile.id || '(unnamed)'}.subscriptionId is required`);
      }
      const hasAccessToken = !!profile.accessToken?.trim() || !!profile.accessTokenCredentialRef?.trim();
      const hasClientId = !!profile.clientId?.trim() || !!profile.clientIdCredentialRef?.trim();
      const hasClientSecret = !!profile.clientSecret?.trim() || !!profile.clientSecretCredentialRef?.trim();
      if (!hasAccessToken && !(profile.tenantId?.trim() && hasClientId && hasClientSecret)) {
        errors.push(`assistant.tools.cloud.azureProfiles.${profile.id || '(unnamed)'}.accessToken/accessTokenCredentialRef or tenantId + clientId + clientSecret is required`);
      }
      if (hasClientId !== hasClientSecret) {
        errors.push(`assistant.tools.cloud.azureProfiles.${profile.id || '(unnamed)'}.clientId and clientSecret must be provided together`);
      }
      assertCredentialRef(
        profile.accessTokenCredentialRef,
        `assistant.tools.cloud.azureProfiles.${profile.id || '(unnamed)'}.accessTokenCredentialRef`,
      );
      assertCredentialRef(
        profile.clientIdCredentialRef,
        `assistant.tools.cloud.azureProfiles.${profile.id || '(unnamed)'}.clientIdCredentialRef`,
      );
      assertCredentialRef(
        profile.clientSecretCredentialRef,
        `assistant.tools.cloud.azureProfiles.${profile.id || '(unnamed)'}.clientSecretCredentialRef`,
      );
      if (profile.blobBaseUrl?.trim()) {
        try {
          normalizeHttpUrlInput(profile.blobBaseUrl);
        } catch (error) {
          errors.push(`assistant.tools.cloud.azureProfiles.${profile.id || '(unnamed)'}.blobBaseUrl ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      for (const [service, endpoint] of Object.entries(profile.endpoints ?? {})) {
        if (!endpoint?.trim()) continue;
        try {
          normalizeHttpUrlInput(endpoint);
        } catch (error) {
          errors.push(`assistant.tools.cloud.azureProfiles.${profile.id || '(unnamed)'}.endpoints.${service} ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
  const sandbox = assistant.tools.sandbox;
  if (sandbox?.enforcementMode && !['permissive', 'strict'].includes(sandbox.enforcementMode)) {
    errors.push("assistant.tools.sandbox.enforcementMode must be 'permissive' or 'strict'");
  }
  if (sandbox?.degradedFallback) {
    const degradedFallback = sandbox.degradedFallback;
    const booleanFields = [
      'allowNetworkTools',
      'allowBrowserTools',
      'allowMcpServers',
      'allowPackageManagers',
      'allowManualCodeTerminals',
    ] as const;
    for (const field of booleanFields) {
      const value = degradedFallback[field];
      if (value !== undefined && typeof value !== 'boolean') {
        errors.push(`assistant.tools.sandbox.degradedFallback.${field} must be a boolean`);
      }
    }
  }
  if (sandbox?.windowsHelper?.enabled) {
    if (sandbox.windowsHelper.command !== undefined && !sandbox.windowsHelper.command.trim()) {
      errors.push('assistant.tools.sandbox.windowsHelper.command must be a non-empty string when provided');
    }
    if (sandbox.windowsHelper.timeoutMs !== undefined && sandbox.windowsHelper.timeoutMs < 1000) {
      errors.push('assistant.tools.sandbox.windowsHelper.timeoutMs must be >= 1000');
    }
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
        if (server.startupApproved !== undefined && typeof server.startupApproved !== 'boolean') {
          errors.push(`assistant.tools.mcp server '${server.id || '(unnamed)'}' startupApproved must be a boolean`);
        }
        if (server.networkAccess !== undefined && typeof server.networkAccess !== 'boolean') {
          errors.push(`assistant.tools.mcp server '${server.id || '(unnamed)'}' networkAccess must be a boolean`);
        }
        if (server.inheritEnv !== undefined && typeof server.inheritEnv !== 'boolean') {
          errors.push(`assistant.tools.mcp server '${server.id || '(unnamed)'}' inheritEnv must be a boolean`);
        }
        if (server.allowedEnvKeys !== undefined) {
          if (!Array.isArray(server.allowedEnvKeys) || server.allowedEnvKeys.some((value) => typeof value !== 'string' || !value.trim())) {
            errors.push(`assistant.tools.mcp server '${server.id || '(unnamed)'}' allowedEnvKeys must be an array of non-empty strings`);
          }
        }
        if (server.trustLevel && !['read_only', 'mutating', 'network', 'external_post'].includes(server.trustLevel)) {
          errors.push(`assistant.tools.mcp server '${server.id || '(unnamed)'}' trustLevel is invalid`);
        }
        if (server.maxCallsPerMinute !== undefined && server.maxCallsPerMinute < 1) {
          errors.push(`assistant.tools.mcp server '${server.id || '(unnamed)'}' maxCallsPerMinute must be >= 1`);
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
        const parsed = new URL(normalizeHttpUrlInput(moltbook.baseUrl));
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
      } catch (error) {
        errors.push(`assistant.threatIntel.moltbook.baseUrl ${error instanceof Error ? error.message : String(error)}`);
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
      const stepType = step.type ?? 'tool';
      if (!['tool', 'instruction', 'delay'].includes(stepType)) {
        errors.push(`assistant.connectors.playbook '${playbook.id}' step '${step.id || '(unnamed)'}' type must be tool, instruction, or delay`);
      } else if (stepType === 'tool') {
        if (!step.toolName?.trim()) {
          errors.push(`assistant.connectors.playbook '${playbook.id}' step '${step.id || '(unnamed)'}' toolName is required`);
        }
      } else if (stepType === 'instruction') {
        if (!step.instruction?.trim()) {
          errors.push(`assistant.connectors.playbook '${playbook.id}' step '${step.id || '(unnamed)'}' instruction is required`);
        }
        if (step.evidenceMode && !['none', 'grounded', 'strict'].includes(step.evidenceMode)) {
          errors.push(`assistant.connectors.playbook '${playbook.id}' step '${step.id || '(unnamed)'}' evidenceMode must be none, grounded, or strict`);
        }
        if (step.citationStyle && !['sources_list', 'inline_markers'].includes(step.citationStyle)) {
          errors.push(`assistant.connectors.playbook '${playbook.id}' step '${step.id || '(unnamed)'}' citationStyle must be sources_list or inline_markers`);
        }
      } else if (stepType === 'delay') {
        if (typeof step.delayMs !== 'number' || step.delayMs <= 0) {
          errors.push(`assistant.connectors.playbook '${playbook.id}' step '${step.id || '(unnamed)'}' delayMs must be > 0`);
        }
        if (playbook.mode === 'parallel') {
          errors.push(`assistant.connectors.playbook '${playbook.id}' step '${step.id || '(unnamed)'}' delay steps are only allowed in sequential mode`);
        }
        if (step.evidenceMode) {
          errors.push(`assistant.connectors.playbook '${playbook.id}' step '${step.id || '(unnamed)'}' evidenceMode is only valid for instruction steps`);
        }
        if (step.citationStyle) {
          errors.push(`assistant.connectors.playbook '${playbook.id}' step '${step.id || '(unnamed)'}' citationStyle is only valid for instruction steps`);
        }
      }
      if (stepType === 'tool' && (step.evidenceMode || step.citationStyle)) {
        errors.push(`assistant.connectors.playbook '${playbook.id}' step '${step.id || '(unnamed)'}' evidenceMode/citationStyle are only valid for instruction steps`);
      }
      if (step.timeoutMs !== undefined && step.timeoutMs < 1000) {
        errors.push(`assistant.connectors.playbook '${playbook.id}' step '${step.id}' timeoutMs must be >= 1000`);
      }
      if (playbook.mode === 'parallel' && stepType === 'instruction') {
        errors.push(`assistant.connectors.playbook '${playbook.id}' step '${step.id || '(unnamed)'}' instruction steps are only allowed in sequential mode`);
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
export interface ConfigLoadOptions {
  integrity?: ControlPlaneIntegrity;
  adoptUntrackedIntegrity?: boolean;
}

export function loadConfigFromFile(filePath: string, options?: ConfigLoadOptions): GuardianAgentConfig {
  if (!existsSync(filePath)) {
    throw new Error(`Configuration file not found: ${filePath}`);
  }

  if (options?.integrity) {
    const verification = options.integrity.verifyFileSync(filePath, {
      adoptUntracked: options.adoptUntrackedIntegrity === true,
      updatedBy: 'config_load',
    });
    if (!verification.ok) {
      throw new Error(verification.message);
    }
  }

  const raw = readFileSync(filePath, 'utf-8');
  const parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA }) as Partial<GuardianAgentConfig> | null;

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

  // Backward compatibility: earlier config updates could create a partial
  // assistant.tools.search object without sources. Normalize that to the
  // empty collection so dashboard reads and hot-reload remain safe.
  if (merged.assistant.tools.search && !Array.isArray(merged.assistant.tools.search.sources)) {
    merged.assistant.tools.search.sources = [];
  }

  // Resolve unified operator controls (sandbox_mode, approval_policy, writable_roots)
  merged = resolveUnifiedOperatorControls(merged);

  merged = normalizeConfigInputs(merged);
  logSecurityBaselineEnforcement(enforceSecurityBaseline(merged, 'config_file'));

  const errors = validateConfig(merged);
  if (errors.length > 0) {
    throw new Error(`Configuration validation failed:\n  - ${errors.join('\n  - ')}`);
  }

  return merged;
}

/**
 * Map simplified operator controls to internal config sections.
 * These are convenience aliases — the internal config sections take precedence
 * if explicitly set alongside the aliases.
 */
function resolveUnifiedOperatorControls(config: GuardianAgentConfig): GuardianAgentConfig {
  const result = { ...config };

  // sandbox_mode → runtime.agentIsolation + assistant.tools.sandbox
  if (result.sandbox_mode) {
    switch (result.sandbox_mode) {
      case 'off':
        result.runtime = {
          ...result.runtime,
          agentIsolation: { ...result.runtime.agentIsolation, enabled: false, mode: 'in-process' },
        };
        if (result.assistant.tools.sandbox) {
          result.assistant.tools.sandbox.enabled = false;
        }
        break;
      case 'workspace-write':
        result.runtime = {
          ...result.runtime,
          agentIsolation: { ...result.runtime.agentIsolation, enabled: true, mode: 'brokered' },
        };
        if (result.assistant.tools.sandbox) {
          result.assistant.tools.sandbox.mode = 'workspace-write';
        }
        break;
      case 'strict':
        result.runtime = {
          ...result.runtime,
          agentIsolation: { ...result.runtime.agentIsolation, enabled: true, mode: 'brokered' },
        };
        if (result.assistant.tools.sandbox) {
          result.assistant.tools.sandbox.mode = 'workspace-write';
          result.assistant.tools.sandbox.enforcementMode = 'strict';
        }
        break;
    }
  }

  // approval_policy → assistant.tools.policyMode
  if (result.approval_policy) {
    const policyMap: Record<string, typeof result.assistant.tools.policyMode> = {
      'on-request': 'approve_each',
      'auto-approve': 'approve_by_policy',
      'autonomous': 'autonomous',
    };
    const mapped = policyMap[result.approval_policy];
    if (mapped) {
      result.assistant = {
        ...result.assistant,
        tools: { ...result.assistant.tools, policyMode: mapped },
      };
    }
  }

  // writable_roots → assistant.tools.allowedPaths + sandbox additionalWritePaths
  if (result.writable_roots && result.writable_roots.length > 0) {
    result.assistant = {
      ...result.assistant,
      tools: {
        ...result.assistant.tools,
        allowedPaths: [...new Set([...result.assistant.tools.allowedPaths, ...result.writable_roots])],
      },
    };
    if (result.assistant.tools.sandbox) {
      result.assistant.tools.sandbox.additionalWritePaths = [
        ...new Set([
          ...(result.assistant.tools.sandbox.additionalWritePaths ?? []),
          ...result.writable_roots,
        ]),
      ];
    }
  }

  return result;
}

/** Load configuration with fallback to defaults. */
export function loadConfig(filePath?: string, options?: ConfigLoadOptions): GuardianAgentConfig {
  const path = filePath ?? DEFAULT_CONFIG_PATH;

  if (!existsSync(path)) {
    // No config file — return defaults
    const fallback = structuredClone(DEFAULT_CONFIG);
    enforceSecurityBaseline(fallback, 'config_file');
    return fallback;
  }

  return loadConfigFromFile(path, options);
}
