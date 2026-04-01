import yaml from 'js-yaml';

import { type WebAuthRuntimeConfig } from '../../channels/web.js';
import { loadConfig } from '../../config/loader.js';
import type { GuardianAgentConfig, WebSearchConfig } from '../../config/types.js';
import { ControlPlaneIntegrity } from '../../guardian/control-plane-integrity.js';
import type { CodingBackendService } from '../../runtime/coding-backend-service.js';
import type { ConnectorPlaybookService } from '../../runtime/connectors.js';
import { resolveRuntimeCredentialView } from '../../runtime/credentials.js';
import type { IdentityService } from '../../runtime/identity.js';
import type { MessageRouter } from '../../runtime/message-router.js';
import type { Runtime } from '../../runtime/runtime.js';
import type { LocalSecretStore } from '../../runtime/secret-store.js';
import type { ToolExecutor } from '../../tools/executor.js';
import { hashObjectSha256Hex } from '../../util/crypto-guardrails.js';
import { writeSecureFileSync } from '../../util/secure-fs.js';

export interface ConfigPersistenceMeta {
  changedBy?: string;
  reason?: string;
}

export interface ConfigPersistenceServiceOptions {
  configPath: string;
  controlPlaneIntegrity: ControlPlaneIntegrity;
  loadRawConfig: () => Record<string, unknown>;
  configRef: { current: GuardianAgentConfig };
  threatIntelWebSearchConfigRef: { current: WebSearchConfig | undefined };
  secretStore: LocalSecretStore;
  runtime: Runtime;
  router: MessageRouter;
  bindTierRoutingProviders: (runtime: Runtime, router: MessageRouter, config: GuardianAgentConfig) => void;
  applyKnowledgeBaseConfigToMemoryStores: (config: GuardianAgentConfig) => void;
  bindSecurityTriageProvider: (runtime: Runtime, config: GuardianAgentConfig) => void;
  identity: IdentityService;
  connectors: ConnectorPlaybookService;
  toolExecutor: ToolExecutor;
  codingBackendServiceRef: { current: CodingBackendService | null };
  codingBackendsDefaultConfig: NonNullable<GuardianAgentConfig['assistant']['tools']['codingBackends']>;
  webAuthStateRef: { current: WebAuthRuntimeConfig };
  applyWebAuthRuntime: (auth: WebAuthRuntimeConfig) => void;
  generateSecureToken: () => string;
  syncAssistantSecurityMonitoringTask: () => void;
  telegramReloadRef: { current: (() => Promise<{ success: boolean; message: string }>) | null };
  reloadSearchRef: { current: (() => Promise<{ success: boolean; message: string }>) | null };
  logError: (message: string, err: unknown) => void;
}

export function createConfigPersistenceService(options: ConfigPersistenceServiceOptions) {
  const persistAndApplyConfig = (
    rawConfig: Record<string, unknown>,
    meta?: ConfigPersistenceMeta,
  ): { success: boolean; message: string } => {
    try {
      const previousRawConfig = options.loadRawConfig();
      const oldPolicyHash = hashObjectSha256Hex(previousRawConfig);
      const newPolicyHash = hashObjectSha256Hex(rawConfig);

      const yamlStr = yaml.dump(rawConfig, { lineWidth: -1, noRefs: true });
      writeSecureFileSync(options.configPath, yamlStr);
      options.controlPlaneIntegrity.signFileSync(options.configPath, meta?.changedBy ?? 'dashboard_config_update');

      const nextConfig = loadConfig(options.configPath, {
        integrity: options.controlPlaneIntegrity,
        adoptUntrackedIntegrity: true,
      });
      const resolvedNextCredentials = resolveRuntimeCredentialView(nextConfig, options.secretStore);
      options.runtime.applyLLMConfiguration({
        llm: resolvedNextCredentials.resolvedLLM,
        defaultProvider: nextConfig.defaultProvider,
      });
      options.bindTierRoutingProviders(options.runtime, options.router, nextConfig);
      options.applyKnowledgeBaseConfigToMemoryStores(nextConfig);
      options.bindSecurityTriageProvider(options.runtime, nextConfig);
      options.identity.update(nextConfig.assistant.identity);
      options.connectors.updateConfig(nextConfig.assistant.connectors);
      options.toolExecutor.updatePolicy({
        mode: nextConfig.assistant.tools.policyMode,
        toolPolicies: nextConfig.assistant.tools.toolPolicies,
        sandbox: {
          allowedPaths: nextConfig.assistant.tools.allowedPaths,
          allowedCommands: nextConfig.assistant.tools.allowedCommands,
          allowedDomains: nextConfig.assistant.tools.allowedDomains,
        },
      });
      options.runtime.applyShellAllowedCommands(nextConfig.assistant.tools.allowedCommands);
      options.toolExecutor.updateWebSearchConfig(resolvedNextCredentials.resolvedWebSearch ?? {});
      options.threatIntelWebSearchConfigRef.current = resolvedNextCredentials.resolvedWebSearch ?? {};
      options.toolExecutor.setCloudConfig(resolvedNextCredentials.resolvedCloud);
      options.codingBackendServiceRef.current?.updateConfig(
        nextConfig.assistant.tools.codingBackends ?? options.codingBackendsDefaultConfig,
      );
      const persistedToken = nextConfig.channels.web?.auth?.token?.trim()
        || nextConfig.channels.web?.authToken?.trim();
      const nextWebAuthMode = nextConfig.channels.web?.auth?.mode ?? 'bearer_required';
      const nextRuntimeToken = persistedToken
        || options.webAuthStateRef.current.token
        || (nextWebAuthMode === 'bearer_required' ? options.generateSecureToken() : undefined);
      options.webAuthStateRef.current = {
        ...options.webAuthStateRef.current,
        mode: nextWebAuthMode,
        token: nextRuntimeToken,
        tokenSource: persistedToken
          ? 'config'
          : (nextRuntimeToken ? (options.webAuthStateRef.current.tokenSource ?? 'ephemeral') : 'ephemeral'),
        rotateOnStartup: nextConfig.channels.web?.auth?.rotateOnStartup ?? false,
        sessionTtlMinutes: nextConfig.channels.web?.auth?.sessionTtlMinutes,
      };
      options.applyWebAuthRuntime(options.webAuthStateRef.current);
      const prevTelegram = options.configRef.current.channels.telegram;
      const prevSearch = options.configRef.current.assistant?.tools?.search;
      options.configRef.current = nextConfig;
      options.syncAssistantSecurityMonitoringTask();

      const nextTelegram = nextConfig.channels.telegram;
      const telegramChanged =
        (prevTelegram?.enabled !== nextTelegram?.enabled)
        || (prevTelegram?.botToken !== nextTelegram?.botToken)
        || (prevTelegram?.botTokenCredentialRef !== nextTelegram?.botTokenCredentialRef)
        || (prevTelegram?.defaultAgent !== nextTelegram?.defaultAgent)
        || (JSON.stringify(prevTelegram?.allowedChatIds) !== JSON.stringify(nextTelegram?.allowedChatIds));
      if (telegramChanged && options.telegramReloadRef.current) {
        options.telegramReloadRef.current().catch((err) => {
          options.logError('Telegram hot-reload failed', err);
        });
      }

      const nextSearch = nextConfig.assistant?.tools?.search;
      const searchChanged =
        (prevSearch?.enabled !== nextSearch?.enabled)
        || (JSON.stringify(prevSearch?.sources) !== JSON.stringify(nextSearch?.sources))
        || (prevSearch?.sqlitePath !== nextSearch?.sqlitePath)
        || (JSON.stringify(prevSearch?.embedding) !== JSON.stringify(nextSearch?.embedding));
      if (searchChanged && options.reloadSearchRef.current) {
        options.reloadSearchRef.current().catch((err) => {
          options.logError('Search engine hot-reload failed', err);
        });
      }

      if (oldPolicyHash !== newPolicyHash) {
        options.runtime.auditLog.record({
          type: 'policy_changed',
          severity: 'info',
          agentId: 'config-center',
          controller: 'ConfigCenter',
          details: {
            oldPolicyHash,
            newPolicyHash,
            changedBy: meta?.changedBy ?? 'dashboard',
            reason: meta?.reason ?? 'config update',
          },
        });
      }
      return { success: true, message: 'Config saved and applied.' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Failed to save config: ${message}` };
    }
  };

  return {
    persistAndApplyConfig,
  };
}
