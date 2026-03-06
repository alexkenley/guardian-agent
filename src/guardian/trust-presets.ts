/**
 * Trust presets — predefined security postures for quick configuration.
 *
 * Each preset defines capabilities, rate limits, resource limits, and
 * tool approval policies. Explicit config values always override presets.
 */

import type { Capability } from './capabilities.js';
import type { GuardianConfig, AgentResourceLimitsConfig } from '../config/types.js';
import type { ToolPolicyMode } from '../tools/types.js';
import { deepMerge } from '../config/loader.js';
import type { GuardianAgentConfig } from '../config/types.js';

/** Available trust preset names. */
export type TrustPresetName = 'locked' | 'safe' | 'balanced' | 'power';

/** Shape of a trust preset definition. */
export interface TrustPreset {
  capabilities: Capability[];
  guardian: Partial<GuardianConfig>;
  resourceLimits: Partial<AgentResourceLimitsConfig>;
  toolPolicyMode: ToolPolicyMode;
}

/** All trust presets. */
export const TRUST_PRESETS: Record<TrustPresetName, TrustPreset> = {
  locked: {
    capabilities: ['read_files'],
    guardian: {
      rateLimit: {
        maxPerMinute: 10,
        maxPerHour: 100,
        burstAllowed: 2,
      },
    },
    resourceLimits: {
      maxInvocationBudgetMs: 15_000,
      maxTokensPerMinute: 5_000,
      maxConcurrentTools: 1,
      maxQueueDepth: 5,
    },
    toolPolicyMode: 'approve_each',
  },

  safe: {
    capabilities: ['read_files', 'read_email'],
    guardian: {
      rateLimit: {
        maxPerMinute: 20,
        maxPerHour: 300,
        burstAllowed: 3,
      },
    },
    resourceLimits: {
      maxInvocationBudgetMs: 30_000,
      maxTokensPerMinute: 10_000,
      maxConcurrentTools: 2,
      maxQueueDepth: 10,
    },
    toolPolicyMode: 'approve_by_policy',
  },

  balanced: {
    capabilities: [
      'read_files',
      'write_files',
      'execute_commands',
      'git_operations',
      'read_email',
      'draft_email',
    ],
    guardian: {
      rateLimit: {
        maxPerMinute: 30,
        maxPerHour: 500,
        burstAllowed: 5,
      },
    },
    resourceLimits: {
      maxInvocationBudgetMs: 60_000,
      maxTokensPerMinute: 20_000,
      maxConcurrentTools: 3,
      maxQueueDepth: 20,
    },
    toolPolicyMode: 'approve_by_policy',
  },

  power: {
    capabilities: [
      'read_files',
      'write_files',
      'execute_commands',
      'network_access',
      'read_email',
      'draft_email',
      'send_email',
      'read_calendar',
      'write_calendar',
      'read_drive',
      'write_drive',
      'read_docs',
      'write_docs',
      'read_sheets',
      'write_sheets',
      'git_operations',
      'install_packages',
    ],
    guardian: {
      rateLimit: {
        maxPerMinute: 60,
        maxPerHour: 2000,
        burstAllowed: 10,
      },
    },
    resourceLimits: {
      maxInvocationBudgetMs: 300_000,
      maxTokensPerMinute: 50_000,
      maxConcurrentTools: 5,
      maxQueueDepth: 50,
    },
    toolPolicyMode: 'autonomous',
  },
};

/** Valid preset names for runtime checking. */
export const TRUST_PRESET_NAMES: readonly TrustPresetName[] = ['locked', 'safe', 'balanced', 'power'];

/** Check if a string is a valid trust preset name. */
export function isValidTrustPreset(name: string): name is TrustPresetName {
  return TRUST_PRESET_NAMES.includes(name as TrustPresetName);
}

/**
 * Apply a trust preset to a config object.
 *
 * The preset provides base values. Explicit config values override the preset.
 * This means: merge preset into defaults first, then user config overrides.
 */
export function applyTrustPreset(
  presetName: TrustPresetName,
  config: GuardianAgentConfig,
): GuardianAgentConfig {
  const preset = TRUST_PRESETS[presetName];
  if (!preset) return config;

  // Apply guardian rate limits from preset as base
  const guardianOverrides: Partial<GuardianConfig> = {
    ...preset.guardian,
  };

  const result = { ...config };

  // Deep merge guardian config — preset values override config values
  result.guardian = deepMerge(result.guardian, guardianOverrides);

  // Apply tool policy mode from preset if not explicitly set
  if (config.assistant?.tools) {
    result.assistant = {
      ...result.assistant,
      tools: {
        ...result.assistant.tools,
        policyMode: preset.toolPolicyMode,
      },
    };
  }

  // Apply default capabilities to agents that don't have explicit ones
  if (result.agents) {
    result.agents = result.agents.map((agent) => {
      if (!agent.capabilities || agent.capabilities.length === 0) {
        return { ...agent, capabilities: [...preset.capabilities] };
      }
      return agent;
    });
  }

  return result;
}
