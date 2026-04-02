import { randomUUID } from 'node:crypto';
import type { GuardianAgentConfig } from '../../config/types.js';
import type { LocalSecretStore } from '../secret-store.js';
import type { ToolPolicySnapshot } from '../../tools/types.js';

interface AssistantConnectorsLike {
  getConfig(): unknown;
}

interface CredentialRefUpdateInput {
  source?: 'env' | 'local';
  env?: string;
  secretId?: string;
  secretValue?: string;
  description?: string;
}

interface CredentialRefRecord {
  source: 'env' | 'local';
  env?: string;
  secretId?: string;
  description?: string;
}

export function createConfigStateHelpers(options: {
  configRef: { current: GuardianAgentConfig };
  loadRawConfig: () => Record<string, unknown>;
  persistAndApplyConfig: (rawConfig: Record<string, unknown>, meta?: { changedBy?: string; reason?: string }) => {
    success: boolean;
    message: string;
  };
  secretStore: Pick<LocalSecretStore, 'set' | 'delete'>;
  connectors: AssistantConnectorsLike;
}) {
  const normalizeCredentialRefUpdates = (refs: Record<string, CredentialRefUpdateInput>): Record<string, CredentialRefRecord> => {
    const entries: Array<[string, CredentialRefRecord]> = [];
    for (const [name, ref] of Object.entries(refs)) {
      const normalizedName = name.trim();
      const normalizedDescription = ref.description?.trim() || undefined;
      if (!normalizedName) continue;

      if ((ref.source ?? 'env') === 'local') {
        const secretId = ref.secretId?.trim() || randomUUID();
        const secretValue = ref.secretValue?.trim();
        if (secretValue) {
          options.secretStore.set(secretId, secretValue);
        }
        entries.push([normalizedName, {
          source: 'local',
          secretId,
          description: normalizedDescription,
        }]);
        continue;
      }

      const normalizedEnv = ref.env?.trim();
      if (!normalizedEnv) continue;
      entries.push([normalizedName, {
        source: 'env',
        env: normalizedEnv,
        description: normalizedDescription,
      }]);
    }
    return Object.fromEntries(entries);
  };

  const upsertLocalCredentialRef = (
    rawConfig: Record<string, unknown>,
    refName: string,
    secretValue: string,
    description: string,
  ): string => {
    const normalizedRefName = refName.trim();
    if (!normalizedRefName) {
      throw new Error('credentialRef is required to store a local secret');
    }

    rawConfig.assistant = rawConfig.assistant ?? {};
    const rawAssistant = rawConfig.assistant as Record<string, unknown>;
    rawAssistant.credentials = (rawAssistant.credentials as Record<string, unknown> | undefined) ?? {};
    const rawCredentials = rawAssistant.credentials as Record<string, unknown>;
    rawCredentials.refs = (rawCredentials.refs as Record<string, unknown> | undefined) ?? {};
    const rawRefs = rawCredentials.refs as Record<string, Record<string, unknown>>;
    const existing = rawRefs[normalizedRefName];
    const existingSecretId = typeof existing?.secretId === 'string' ? existing.secretId.trim() : '';
    const secretId = existingSecretId || randomUUID();

    options.secretStore.set(secretId, secretValue);
    rawRefs[normalizedRefName] = {
      source: 'local',
      secretId,
      description,
    };
    return normalizedRefName;
  };

  const deleteUnusedLocalSecrets = (
    previousRefs: Record<string, CredentialRefRecord>,
    nextRefs: Record<string, CredentialRefRecord>,
  ): void => {
    const nextSecretIds = new Set(
      Object.values(nextRefs)
        .filter((ref) => ref.source === 'local')
        .map((ref) => ref.secretId?.trim())
        .filter((secretId): secretId is string => !!secretId),
    );

    for (const ref of Object.values(previousRefs)) {
      if (ref.source !== 'local') continue;
      const secretId = ref.secretId?.trim();
      if (secretId && !nextSecretIds.has(secretId)) {
        options.secretStore.delete(secretId);
      }
    }
  };

  const persistToolsState = (policy: ToolPolicySnapshot): { success: boolean; message: string } => {
    const rawConfig = options.loadRawConfig();
    rawConfig.assistant = rawConfig.assistant ?? {};
    const rawAssistant = rawConfig.assistant as Record<string, unknown>;
    const existingTools = (rawAssistant.tools as Record<string, unknown> | undefined) ?? {};
    rawAssistant.tools = {
      ...existingTools,
      enabled: options.configRef.current.assistant.tools.enabled,
      policyMode: policy.mode,
      toolPolicies: policy.toolPolicies,
      allowExternalPosting: options.configRef.current.assistant.tools.allowExternalPosting,
      allowedPaths: policy.sandbox.allowedPaths,
      allowedCommands: policy.sandbox.allowedCommands,
      allowedDomains: policy.sandbox.allowedDomains,
      browser: options.configRef.current.assistant.tools.browser,
      disabledCategories: options.configRef.current.assistant.tools.disabledCategories ?? [],
      providerRouting: options.configRef.current.assistant.tools.providerRouting ?? {},
      providerRoutingEnabled: options.configRef.current.assistant.tools.providerRoutingEnabled !== false,
    };
    return options.persistAndApplyConfig(rawConfig, {
      changedBy: 'tools-control-plane',
      reason: 'tool policy update',
    });
  };

  const persistSkillsState = (): { success: boolean; message: string } => {
    const rawConfig = options.loadRawConfig();
    rawConfig.assistant = rawConfig.assistant ?? {};
    const rawAssistant = rawConfig.assistant as Record<string, unknown>;
    const existingSkills = (rawAssistant.skills as Record<string, unknown> | undefined) ?? {};
    rawAssistant.skills = {
      ...existingSkills,
      enabled: options.configRef.current.assistant.skills.enabled,
      roots: [...options.configRef.current.assistant.skills.roots],
      autoSelect: options.configRef.current.assistant.skills.autoSelect,
      maxActivePerRequest: options.configRef.current.assistant.skills.maxActivePerRequest,
      disabledSkills: [...options.configRef.current.assistant.skills.disabledSkills],
    };
    return options.persistAndApplyConfig(rawConfig, {
      changedBy: 'skills-control-plane',
      reason: 'skills runtime update',
    });
  };

  const persistConnectorsState = (): { success: boolean; message: string } => {
    const rawConfig = options.loadRawConfig();
    rawConfig.assistant = rawConfig.assistant ?? {};
    const rawAssistant = rawConfig.assistant as Record<string, unknown>;
    rawAssistant.connectors = options.connectors.getConfig();
    return options.persistAndApplyConfig(rawConfig, {
      changedBy: 'connectors-control-plane',
      reason: 'connector/playbook update',
    });
  };

  return {
    normalizeCredentialRefUpdates,
    upsertLocalCredentialRef,
    deleteUnusedLocalSecrets,
    persistToolsState,
    persistSkillsState,
    persistConnectorsState,
  };
}
