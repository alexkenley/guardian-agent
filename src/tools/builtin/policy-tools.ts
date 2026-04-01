import type { AgentPolicyUpdatesConfig } from '../../config/types.js';
import { ToolRegistry } from '../registry.js';
import type { ToolExecutionRequest, ToolPolicySetting, ToolPolicySnapshot } from '../types.js';

type ToolPolicyUpdate = {
  mode?: ToolPolicySnapshot['mode'];
  toolPolicies?: Record<string, ToolPolicySetting>;
  sandbox?: {
    allowedPaths?: string[];
    allowedCommands?: string[];
    allowedDomains?: string[];
  };
};

interface PolicyToolRegistrarContext {
  registry: ToolRegistry;
  requireString: (value: unknown, field: string) => string;
  agentPolicyUpdates?: AgentPolicyUpdatesConfig;
  getPolicy: () => ToolPolicySnapshot;
  updatePolicy: (update: ToolPolicyUpdate) => ToolPolicySnapshot;
  persistPolicyUpdate?: (
    policy: ToolPolicySnapshot,
    meta?: { browserAllowedDomains?: string[] },
  ) => void;
  isCodeWorkspacePolicyNoOp: (
    action: string,
    value: string,
    request?: Partial<ToolExecutionRequest>,
  ) => boolean;
  getEffectiveAllowedPaths: (request?: Partial<ToolExecutionRequest>) => string[];
  getExplicitBrowserAllowedDomains: () => string[] | null;
  setExplicitBrowserAllowedDomains: (domains: string[]) => void;
}

export function registerBuiltinPolicyTools(context: PolicyToolRegistrarContext): void {
  const policyUpdates = context.agentPolicyUpdates;
  if (!policyUpdates?.allowedPaths && !policyUpdates?.allowedCommands && !policyUpdates?.allowedDomains) {
    return;
  }

  const enabledActions: string[] = [];
  if (policyUpdates.allowedPaths) enabledActions.push('add_path', 'remove_path');
  if (policyUpdates.allowedCommands) enabledActions.push('add_command', 'remove_command');
  if (policyUpdates.allowedDomains) enabledActions.push('add_domain', 'remove_domain');
  if (policyUpdates.toolPolicies) enabledActions.push('set_tool_policy_auto', 'set_tool_policy_manual', 'set_tool_policy_deny');

  context.registry.register(
    {
      name: 'update_tool_policy',
      description: `Update tool sandbox policy (allowed paths, commands, or domains). Always requires user approval regardless of policy mode. ` +
        `Enabled actions: ${enabledActions.join(', ')}. ` +
        `Use this when the user asks to grant access to a directory, allow a command, or add a domain.`,
      shortDescription: 'Update tool sandbox policy (paths, commands, domains).',
      risk: 'external_post',
      category: 'system',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: `Action to perform: ${enabledActions.join(', ')}.`,
          },
          value: {
            type: 'string',
            description: 'The path, command prefix, or domain to add/remove.',
          },
        },
        required: ['action', 'value'],
      },
    },
    async (args, request) => {
      const action = context.requireString(args.action, 'action').trim();
      const value = context.requireString(args.value, 'value').trim();
      if (!value) return { success: false, error: 'Value cannot be empty.' };
      if (!enabledActions.includes(action)) {
        return { success: false, error: `Action '${action}' is not enabled. Enabled actions: ${enabledActions.join(', ')}.` };
      }

      if (action === 'add_path' && context.isCodeWorkspacePolicyNoOp(action, value, request)) {
        return {
          success: true,
          output: {
            message: `Path '${value}' is already trusted for the active coding session workspace.`,
            allowedPaths: context.getEffectiveAllowedPaths(request),
          },
        };
      }

      const current = context.getPolicy();
      let updated: ToolPolicyUpdate;
      let browserAllowedDomainsUpdate: string[] | undefined;

      switch (action) {
        case 'add_path': {
          if (current.sandbox.allowedPaths.includes(value)) {
            return { success: true, output: { message: `Path '${value}' is already in the allowlist.`, allowedPaths: current.sandbox.allowedPaths } };
          }
          updated = { sandbox: { allowedPaths: [...current.sandbox.allowedPaths, value] } };
          break;
        }
        case 'remove_path': {
          const filtered = current.sandbox.allowedPaths.filter((path) => path !== value);
          if (filtered.length === current.sandbox.allowedPaths.length) {
            return { success: false, error: `Path '${value}' is not in the allowlist.` };
          }
          if (filtered.length === 0) {
            return { success: false, error: 'Cannot remove the last allowed path — at least one must remain.' };
          }
          updated = { sandbox: { allowedPaths: filtered } };
          break;
        }
        case 'add_command': {
          if (current.sandbox.allowedCommands.includes(value)) {
            return { success: true, output: { message: `Command '${value}' is already in the allowlist.`, allowedCommands: current.sandbox.allowedCommands } };
          }
          updated = { sandbox: { allowedCommands: [...current.sandbox.allowedCommands, value] } };
          break;
        }
        case 'remove_command': {
          const filtered = current.sandbox.allowedCommands.filter((command) => command !== value);
          if (filtered.length === current.sandbox.allowedCommands.length) {
            return { success: false, error: `Command '${value}' is not in the allowlist.` };
          }
          updated = { sandbox: { allowedCommands: filtered } };
          break;
        }
        case 'add_domain': {
          const normalizedValue = value.toLowerCase();
          const currentBrowserDomains = context.getExplicitBrowserAllowedDomains();
          const browserNeedsUpdate = !!currentBrowserDomains && !currentBrowserDomains.includes(normalizedValue);
          if (current.sandbox.allowedDomains.includes(normalizedValue) && !browserNeedsUpdate) {
            return { success: true, output: { message: `Domain '${normalizedValue}' is already in the allowlist.`, allowedDomains: current.sandbox.allowedDomains } };
          }
          updated = current.sandbox.allowedDomains.includes(normalizedValue)
            ? {}
            : { sandbox: { allowedDomains: [...current.sandbox.allowedDomains, normalizedValue] } };
          if (browserNeedsUpdate) {
            browserAllowedDomainsUpdate = [...currentBrowserDomains!, normalizedValue];
            context.setExplicitBrowserAllowedDomains(browserAllowedDomainsUpdate);
          }
          break;
        }
        case 'remove_domain': {
          const normalizedValue = value.toLowerCase();
          const filtered = current.sandbox.allowedDomains.filter((domain) => domain !== normalizedValue);
          const currentBrowserDomains = context.getExplicitBrowserAllowedDomains();
          const browserHasDomain = !!currentBrowserDomains && currentBrowserDomains.includes(normalizedValue);
          if (filtered.length === current.sandbox.allowedDomains.length && !browserHasDomain) {
            return { success: false, error: `Domain '${normalizedValue}' is not in the allowlist.` };
          }
          updated = filtered.length === current.sandbox.allowedDomains.length
            ? {}
            : { sandbox: { allowedDomains: filtered } };
          if (browserHasDomain) {
            browserAllowedDomainsUpdate = currentBrowserDomains!.filter((domain) => domain !== normalizedValue);
            context.setExplicitBrowserAllowedDomains(browserAllowedDomainsUpdate);
          }
          break;
        }
        case 'set_tool_policy_auto': {
          updated = { toolPolicies: { [value]: 'auto' } };
          break;
        }
        case 'set_tool_policy_manual': {
          updated = { toolPolicies: { [value]: 'manual' } };
          break;
        }
        case 'set_tool_policy_deny': {
          updated = { toolPolicies: { [value]: 'deny' } };
          break;
        }
        default:
          return { success: false, error: `Unknown action: ${action}` };
      }

      const result = updated.mode || updated.toolPolicies || updated.sandbox
        ? context.updatePolicy(updated)
        : current;
      try {
        context.persistPolicyUpdate?.(result, browserAllowedDomainsUpdate ? { browserAllowedDomains: browserAllowedDomainsUpdate } : undefined);
      } catch {
        // Best-effort persist.
      }
      return {
        success: true,
        output: {
          message: `Policy updated: ${action} '${value}'.`,
          allowedPaths: result.sandbox.allowedPaths,
          allowedCommands: result.sandbox.allowedCommands,
          allowedDomains: result.sandbox.allowedDomains,
          ...(browserAllowedDomainsUpdate ? { browserAllowedDomains: browserAllowedDomainsUpdate } : {}),
        },
      };
    },
  );
}
