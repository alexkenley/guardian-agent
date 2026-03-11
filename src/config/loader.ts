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
  const credentialRefs = config.assistant.credentials.refs;

  const assertCredentialRef = (value: string | undefined, path: string): void => {
    if (value === undefined) return;
    const ref = value.trim();
    if (!ref) {
      errors.push(`${path} must be a non-empty string when provided`);
      return;
    }
    if (!credentialRefs[ref]) {
      errors.push(`${path} references unknown credential ref '${ref}'`);
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
    if (!['ollama', 'anthropic', 'openai'].includes(llm.provider)) {
      errors.push(`llm.${name}.provider must be 'ollama', 'anthropic', or 'openai'`);
    }
    if (!llm.model) {
      errors.push(`llm.${name}.model is required`);
    }
    assertCredentialRef(llm.credentialRef, `llm.${name}.credentialRef`);
    if (llm.provider !== 'ollama' && !llm.apiKey && !llm.credentialRef) {
      errors.push(`llm.${name}.apiKey or llm.${name}.credentialRef is required for provider '${llm.provider}'`);
    }
  }

  if (config.channels.telegram?.enabled && !config.channels.telegram.botToken) {
    errors.push('channels.telegram.botToken is required when Telegram is enabled');
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
    if (ref.source !== 'env') {
      errors.push(`assistant.credentials.refs.${name}.source must be 'env'`);
    }
    if (!ref.env?.trim()) {
      errors.push(`assistant.credentials.refs.${name}.env is required`);
    }
  }
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
  if (!['info', 'warn', 'critical'].includes(assistant.notifications.minSeverity)) {
    errors.push("assistant.notifications.minSeverity must be 'info', 'warn', or 'critical'");
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
    'agent_error',
    'agent_stalled',
    'policy_engine_started',
    'policy_mode_changed',
    'policy_rules_reloaded',
    'policy_shadow_mismatch',
  ]);
  for (const eventType of assistant.notifications.auditEventTypes ?? []) {
    if (!validNotificationAuditTypes.has(eventType)) {
      errors.push(`assistant.notifications.auditEventTypes contains unknown event '${eventType}'`);
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
          const parsed = new URL(profile.apiBaseUrl);
          if (!['http:', 'https:'].includes(parsed.protocol)) {
            errors.push(`assistant.tools.cloud.vercelProfiles.${profile.id || '(unnamed)'}.apiBaseUrl must use http or https`);
          }
        } catch {
          errors.push(`assistant.tools.cloud.vercelProfiles.${profile.id || '(unnamed)'}.apiBaseUrl must be a valid URL`);
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
          const parsed = new URL(profile.apiBaseUrl);
          if (!['http:', 'https:'].includes(parsed.protocol)) {
            errors.push(`assistant.tools.cloud.cloudflareProfiles.${profile.id || '(unnamed)'}.apiBaseUrl must use http or https`);
          }
        } catch {
          errors.push(`assistant.tools.cloud.cloudflareProfiles.${profile.id || '(unnamed)'}.apiBaseUrl must be a valid URL`);
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
          const parsed = new URL(endpoint);
          if (!['http:', 'https:'].includes(parsed.protocol)) {
            errors.push(`assistant.tools.cloud.awsProfiles.${profile.id || '(unnamed)'}.endpoints.${service} must use http or https`);
          }
        } catch {
          errors.push(`assistant.tools.cloud.awsProfiles.${profile.id || '(unnamed)'}.endpoints.${service} must be a valid URL`);
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
          const parsed = new URL(endpoint);
          if (!['http:', 'https:'].includes(parsed.protocol)) {
            errors.push(`assistant.tools.cloud.gcpProfiles.${profile.id || '(unnamed)'}.endpoints.${service} must use http or https`);
          }
        } catch {
          errors.push(`assistant.tools.cloud.gcpProfiles.${profile.id || '(unnamed)'}.endpoints.${service} must be a valid URL`);
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
          const parsed = new URL(profile.blobBaseUrl);
          if (!['http:', 'https:'].includes(parsed.protocol)) {
            errors.push(`assistant.tools.cloud.azureProfiles.${profile.id || '(unnamed)'}.blobBaseUrl must use http or https`);
          }
        } catch {
          errors.push(`assistant.tools.cloud.azureProfiles.${profile.id || '(unnamed)'}.blobBaseUrl must be a valid URL`);
        }
      }
      for (const [service, endpoint] of Object.entries(profile.endpoints ?? {})) {
        if (!endpoint?.trim()) continue;
        try {
          const parsed = new URL(endpoint);
          if (!['http:', 'https:'].includes(parsed.protocol)) {
            errors.push(`assistant.tools.cloud.azureProfiles.${profile.id || '(unnamed)'}.endpoints.${service} must use http or https`);
          }
        } catch {
          errors.push(`assistant.tools.cloud.azureProfiles.${profile.id || '(unnamed)'}.endpoints.${service} must be a valid URL`);
        }
      }
    }
  }
  const sandbox = assistant.tools.sandbox;
  if (sandbox?.enforcementMode && !['permissive', 'strict'].includes(sandbox.enforcementMode)) {
    errors.push("assistant.tools.sandbox.enforcementMode must be 'permissive' or 'strict'");
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
