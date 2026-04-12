import type { GuardianAgentConfig } from './types.js';
import { normalizeCpanelConnectionConfig } from '../tools/cloud/cpanel-profile.js';

function trimOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function trimStringArray(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  const normalized = values
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeHttpUrlInput(
  raw: string,
  options?: { allowPath?: boolean },
): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('must be a valid URL');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('must be a valid URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('must use http or https');
  }
  if (parsed.username || parsed.password) {
    throw new Error('must not include embedded credentials');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('must not include a query string or fragment');
  }
  if (options?.allowPath === false && parsed.pathname && parsed.pathname !== '/') {
    throw new Error('must not include a path');
  }

  const pathname = parsed.pathname && parsed.pathname !== '/'
    ? parsed.pathname.replace(/\/+$/, '')
    : '';
  return `${parsed.origin}${pathname}`;
}

export function normalizeOptionalHttpUrlInput(
  raw: string | undefined,
  options?: { allowPath?: boolean },
): string | undefined {
  if (!raw?.trim()) return undefined;
  return normalizeHttpUrlInput(raw, options);
}

export function normalizeHttpUrlRecord(
  value: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!value) return undefined;
  const normalized: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!entry?.trim()) continue;
    normalized[key] = normalizeHttpUrlInput(entry);
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function normalizeConfigInputs(config: GuardianAgentConfig): GuardianAgentConfig {
  return {
    ...config,
    llm: Object.fromEntries(
      Object.entries(config.llm).map(([name, provider]) => [
        name,
        {
          ...provider,
          baseUrl: normalizeOptionalHttpUrlInput(provider.baseUrl),
        },
      ]),
    ),
    assistant: {
      ...config.assistant,
      secondBrain: config.assistant.secondBrain
        ? {
          ...config.assistant.secondBrain,
          profile: {
            ...config.assistant.secondBrain.profile,
            timezone: trimOptionalString(config.assistant.secondBrain.profile.timezone),
            workdayStart: trimOptionalString(config.assistant.secondBrain.profile.workdayStart),
            workdayEnd: trimOptionalString(config.assistant.secondBrain.profile.workdayEnd),
          },
          delivery: {
            ...config.assistant.secondBrain.delivery,
            defaultChannels: trimStringArray(config.assistant.secondBrain.delivery.defaultChannels)?.filter((channel): channel is 'web' | 'cli' | 'telegram' => (
              channel === 'web' || channel === 'cli' || channel === 'telegram'
            )) ?? [],
          },
        }
        : config.assistant.secondBrain,
      threatIntel: {
        ...config.assistant.threatIntel,
        moltbook: config.assistant.threatIntel.moltbook
          ? {
            ...config.assistant.threatIntel.moltbook,
            baseUrl: normalizeOptionalHttpUrlInput(config.assistant.threatIntel.moltbook.baseUrl),
          }
          : config.assistant.threatIntel.moltbook,
      },
      tools: {
        ...config.assistant.tools,
        cloud: config.assistant.tools.cloud
          ? {
            ...config.assistant.tools.cloud,
            cpanelProfiles: (config.assistant.tools.cloud.cpanelProfiles ?? []).map((profile) =>
              normalizeCpanelConnectionConfig(profile)),
            vercelProfiles: (config.assistant.tools.cloud.vercelProfiles ?? []).map((profile) => ({
              ...profile,
              apiBaseUrl: normalizeOptionalHttpUrlInput(profile.apiBaseUrl),
            })),
            cloudflareProfiles: (config.assistant.tools.cloud.cloudflareProfiles ?? []).map((profile) => ({
              ...profile,
              apiBaseUrl: normalizeOptionalHttpUrlInput(profile.apiBaseUrl),
            })),
            awsProfiles: (config.assistant.tools.cloud.awsProfiles ?? []).map((profile) => ({
              ...profile,
              endpoints: normalizeHttpUrlRecord(profile.endpoints),
            })),
            gcpProfiles: (config.assistant.tools.cloud.gcpProfiles ?? []).map((profile) => ({
              ...profile,
              endpoints: normalizeHttpUrlRecord(profile.endpoints),
            })),
            azureProfiles: (config.assistant.tools.cloud.azureProfiles ?? []).map((profile) => ({
              ...profile,
              blobBaseUrl: normalizeOptionalHttpUrlInput(profile.blobBaseUrl),
              endpoints: normalizeHttpUrlRecord(profile.endpoints),
            })),
          }
          : config.assistant.tools.cloud,
      },
      performance: config.assistant.performance
        ? {
          ...config.assistant.performance,
          protectedProcesses: config.assistant.performance.protectedProcesses
            ? {
              ...config.assistant.performance.protectedProcesses,
              names: trimStringArray(config.assistant.performance.protectedProcesses.names) ?? [],
            }
            : config.assistant.performance.protectedProcesses,
          profiles: (config.assistant.performance.profiles ?? []).map((profile) => ({
            ...profile,
            id: trimOptionalString(profile.id) ?? profile.id,
            name: trimOptionalString(profile.name) ?? profile.name,
            processRules: profile.processRules
              ? {
                ...profile.processRules,
                terminate: trimStringArray(profile.processRules.terminate),
                protect: trimStringArray(profile.processRules.protect),
              }
              : profile.processRules,
            autoActions: profile.autoActions
              ? {
                ...profile.autoActions,
                allowedActionIds: trimStringArray(profile.autoActions.allowedActionIds) ?? [],
              }
              : profile.autoActions,
            latencyTargets: (profile.latencyTargets ?? []).map((target) => ({
              ...target,
              id: trimOptionalString(target.id) ?? target.id,
              target: normalizeOptionalHttpUrlInput(target.target),
              targetRef: trimOptionalString(target.targetRef),
            })),
          })),
        }
        : config.assistant.performance,
    },
  };
}
