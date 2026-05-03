import type { DashboardCallbacks } from '../../channels/web-types.js';
import type { BrowserConfig, GuardianAgentConfig } from '../../config/types.js';
import type { CodeSessionStore } from '../code-sessions.js';
import type { IdentityService } from '../identity.js';
import type { PendingActionStore } from '../pending-actions.js';
import { reconcilePendingApprovalAction, toPendingActionClientMetadata } from '../pending-actions.js';
import type { SkillRegistry } from '../../skills/registry.js';
import { getProviderLocality } from '../../llm/provider-metadata.js';
import type { ToolExecutor } from '../../tools/executor.js';
import type { ToolPolicySnapshot, ToolRunResponse } from '../../tools/types.js';

type ToolsDashboardCallbacks = Pick<
  DashboardCallbacks,
  | 'onToolsState'
  | 'onToolsPendingApprovals'
  | 'onPendingActionCurrent'
  | 'onPendingActionReset'
  | 'onSkillsState'
  | 'onSkillsUpdate'
  | 'onToolsRun'
  | 'onToolsPreflight'
  | 'onToolsPolicyUpdate'
  | 'onBrowserConfigState'
  | 'onBrowserConfigUpdate'
  | 'onToolsApprovalDecision'
  | 'onToolsCategories'
  | 'onToolsCategoryToggle'
  | 'onToolsProviderRoutingUpdate'
>;

type ToolRunInput = Parameters<NonNullable<DashboardCallbacks['onToolsRun']>>[0];
type ToolApprovalDecisionInput = Parameters<NonNullable<DashboardCallbacks['onToolsApprovalDecision']>>[0];
type BrowserConfigUpdateResult = Awaited<ReturnType<NonNullable<DashboardCallbacks['onBrowserConfigUpdate']>>>;

type ToolRunCodeRequestMetadata = {
  workspaceRoot?: string;
  sessionId?: string;
};

interface ToolsDashboardCallbackOptions {
  configRef: { current: GuardianAgentConfig };
  toolExecutor: ToolExecutor;
  skillRegistry: SkillRegistry | null;
  enabledManagedProviders: Set<string>;
  identity: IdentityService;
  pendingActionStore: PendingActionStore;
  codeSessionStore: CodeSessionStore;
  chatAgents?: Iterable<{
    resetPendingState: (args: {
      userId: string;
      channel: string;
      surfaceId?: string;
      approvalIds?: string[];
    }) => void;
  }>;
  workerManager?: {
    resetPendingState?: (args: {
      userId: string;
      channel: string;
      approvalIds?: string[];
    }) => void;
  };
  resolveSharedStateAgentId: (agentId?: string) => string | undefined;
  getCodeSessionSurfaceId: (args: { channel?: string; surfaceId?: string; userId?: string; principalId?: string }) => string;
  readMessageSurfaceId: (value: unknown) => string | undefined;
  readCodeRequestMetadata: (metadata: unknown) => ToolRunCodeRequestMetadata | undefined;
  persistToolsState: (policy: ToolPolicySnapshot) => { success: boolean; message: string };
  persistSkillsState: () => { success: boolean; message: string };
  applyBrowserRuntimeConfig: (browserConfig: GuardianAgentConfig['assistant']['tools']['browser']) => Promise<BrowserConfigUpdateResult>;
  decideDashboardToolApproval: (input: ToolApprovalDecisionInput) => ReturnType<NonNullable<DashboardCallbacks['onToolsApprovalDecision']>>;
  getCategoryDefaults: () => Record<string, 'local' | 'external'>;
  trackSystemAnalytics: (type: string, metadata?: Record<string, unknown>) => void;
  trackToolRunAnalytics: (input: ToolRunInput, result: ToolRunResponse) => void;
}

export function createToolsDashboardCallbacks(
  options: ToolsDashboardCallbackOptions,
): ToolsDashboardCallbacks {
  const resolvePendingActionScope = (args: { userId: string; channel: string; surfaceId: string }) => {
    const preferredAgentId = options.configRef.current.channels.web?.defaultAgent
      || options.configRef.current.agents[0]?.id
      || 'default';
    const stateAgentId = options.resolveSharedStateAgentId(preferredAgentId) ?? preferredAgentId;
    const canonicalUserId = options.identity.resolveCanonicalUserId(args.channel, args.userId);
    return {
      stateAgentId,
      canonicalUserId,
      scope: {
        agentId: stateAgentId,
        userId: canonicalUserId,
        channel: args.channel,
        surfaceId: args.surfaceId,
      },
    };
  };

  return {
    onToolsState: ({ limit } = {}) => ({
      enabled: options.toolExecutor.isEnabled(),
      tools: options.toolExecutor.listToolDefinitions(),
      policy: options.toolExecutor.getPolicy(),
      approvals: options.toolExecutor.listApprovals(limit ?? 50),
      jobs: options.toolExecutor.listJobs(limit ?? 50),
      notices: options.toolExecutor.getRuntimeNotices(),
      sandbox: options.toolExecutor.getSandboxHealth(),
      categories: options.toolExecutor.getCategoryInfo(),
      disabledCategories: options.toolExecutor.getDisabledCategories(),
      providerRouting: options.configRef.current.assistant.tools.providerRouting ?? {},
      providerRoutingEnabled: options.configRef.current.assistant.tools.providerRoutingEnabled !== false,
      defaultProviderLocality: (
        getProviderLocality(options.configRef.current.llm[options.configRef.current.defaultProvider]?.provider)
          ?? 'external'
      ) as 'local' | 'external',
      categoryDefaults: options.getCategoryDefaults(),
    }),

    onToolsPendingApprovals: ({ userId, channel, principalId, limit }) => {
      const canonicalUserId = options.identity.resolveCanonicalUserId(channel, userId);
      const ids = options.toolExecutor.listPendingApprovalIdsForUser(canonicalUserId, channel, {
        limit: limit ?? 20,
        includeUnscoped: channel === 'web',
        principalId,
      });
      const summaries = options.toolExecutor.getApprovalSummaries(ids);
      return ids.map((id) => {
        const summary = summaries.get(id);
        return {
          id,
          toolName: summary?.toolName ?? 'unknown',
          argsPreview: summary?.argsPreview ?? '',
          actionLabel: summary?.actionLabel ?? '',
          ...(summary?.requestId ? { requestId: summary.requestId } : {}),
          ...(summary?.codeSessionId ? { codeSessionId: summary.codeSessionId } : {}),
        };
      });
    },

    onPendingActionCurrent: ({ userId, principalId, channel, surfaceId }) => {
      const { canonicalUserId, scope } = resolvePendingActionScope({ userId, channel, surfaceId });
      const pendingAction = options.pendingActionStore.resolveActiveForSurface({
        ...scope,
      });
      const liveApprovalIds = options.toolExecutor.listPendingApprovalIdsForUser(canonicalUserId, channel, {
        includeUnscoped: channel === 'web',
        ...(principalId?.trim() ? { principalId } : { principalId: canonicalUserId }),
      });
      const allPendingApprovalIds = options.toolExecutor
        .listApprovals(200, 'pending')
        .map((approval) => approval.id);
      const reconciledPendingAction = reconcilePendingApprovalAction(
        options.pendingActionStore,
        pendingAction,
        {
          liveApprovalIds,
          liveApprovalSummaries: options.toolExecutor.getApprovalSummaries(liveApprovalIds),
          allPendingApprovalIds,
          scope,
        },
      );
      return {
        pendingAction: toPendingActionClientMetadata(reconciledPendingAction) ?? null,
      };
    },

    onPendingActionReset: async ({ userId, principalId, principalRole, channel, surfaceId }) => {
      const { canonicalUserId, scope } = resolvePendingActionScope({ userId, channel, surfaceId });
      const normalizedChannelUserId = userId.trim() || canonicalUserId;
      const userIdsForCleanup = [...new Set([canonicalUserId, normalizedChannelUserId].filter(Boolean))];
      const pendingAction = options.pendingActionStore.resolveActiveForSurface(scope);
      const liveApprovalIds = [...new Set(userIdsForCleanup.flatMap((nextUserId) => (
        options.toolExecutor.listPendingApprovalIdsForUser(nextUserId, channel, {
          includeUnscoped: channel === 'web',
          ...(principalId?.trim() ? { principalId } : {}),
        })
      )))];
      const approvalIdsToClear = [...new Set([
        ...liveApprovalIds,
        ...(
          pendingAction?.blocker.kind === 'approval'
            ? (pendingAction.blocker.approvalIds ?? [])
            : []
        ),
      ])];
      const clearedApprovalIds: string[] = [];
      const ignoredApprovalIds: string[] = [];
      const failedApprovalIds: string[] = [];
      const actor = principalId?.trim() || canonicalUserId;
      const actorRoleResolved = principalRole ?? 'owner';

      for (const approvalId of approvalIdsToClear) {
        const result = await options.toolExecutor.decideApproval(
          approvalId,
          'denied',
          actor,
          actorRoleResolved,
          'Cleared from chat pending-state reset.',
        );
        if (result.success) {
          clearedApprovalIds.push(approvalId);
          continue;
        }
        if (result.message.includes('not found')) {
          ignoredApprovalIds.push(approvalId);
          continue;
        }
        failedApprovalIds.push(approvalId);
      }

      const cancelledPendingAction = pendingAction
        ? options.pendingActionStore.cancel(pendingAction.id)
        : null;

      if (options.chatAgents) {
        for (const agent of options.chatAgents) {
          for (const nextUserId of userIdsForCleanup) {
            agent.resetPendingState({
              userId: nextUserId,
              channel,
              surfaceId,
              approvalIds: approvalIdsToClear,
            });
          }
        }
      }
      for (const nextUserId of userIdsForCleanup) {
        options.workerManager?.resetPendingState?.({
          userId: nextUserId,
          channel,
          approvalIds: approvalIdsToClear,
        });
      }

      const summaryParts: string[] = [];
      if (cancelledPendingAction) summaryParts.push('cleared 1 pending action');
      if (clearedApprovalIds.length > 0) {
        summaryParts.push(`cleared ${clearedApprovalIds.length} pending approval${clearedApprovalIds.length === 1 ? '' : 's'}`);
      }
      if (ignoredApprovalIds.length > 0) {
        summaryParts.push(`dropped ${ignoredApprovalIds.length} stale approval reference${ignoredApprovalIds.length === 1 ? '' : 's'}`);
      }
      const message = summaryParts.length > 0
        ? `Cleared pending state for this chat: ${summaryParts.join(', ')}.${failedApprovalIds.length > 0 ? ` ${failedApprovalIds.length} approval${failedApprovalIds.length === 1 ? '' : 's'} could not be cleared.` : ''}`
        : 'No pending actions or approvals were active for this chat.';

      options.trackSystemAnalytics('chat_pending_state_reset', {
        channel,
        surfaceId,
        pendingActionCleared: Boolean(cancelledPendingAction),
        clearedApprovalCount: clearedApprovalIds.length,
        staleApprovalReferenceCount: ignoredApprovalIds.length,
        failedApprovalCount: failedApprovalIds.length,
      });

      return {
        success: true,
        message,
        details: {
          ...(cancelledPendingAction ? { clearedPendingActionId: cancelledPendingAction.id } : {}),
          clearedApprovalIds,
          ignoredApprovalIds,
          failedApprovalIds,
        },
      };
    },

    onSkillsState: () => {
      const config = options.configRef.current.assistant.skills;
      const statuses = options.skillRegistry?.listStatus() ?? [];
      const managedProviderIds = new Set<string>(['gws', 'm365']);
      for (const skill of statuses) {
        if (skill.requiredManagedProvider) {
          managedProviderIds.add(skill.requiredManagedProvider);
        }
      }
      return {
        enabled: config.enabled,
        autoSelect: config.autoSelect,
        maxActivePerRequest: config.maxActivePerRequest,
        managedProviders: [...managedProviderIds]
          .sort((a, b) => a.localeCompare(b))
          .map((id) => ({
            id,
            enabled: options.enabledManagedProviders.has(id),
          })),
        skills: statuses.map((skill) => {
          const requiresProvider = skill.requiredManagedProvider;
          const providerReady = requiresProvider ? options.enabledManagedProviders.has(requiresProvider) : undefined;
          let disabledReason: string | undefined;
          if (!skill.enabled) {
            disabledReason = 'Disabled at runtime.';
          } else if (requiresProvider && !providerReady) {
            disabledReason = `Requires managed provider '${requiresProvider}' to be enabled and connected.`;
          }
          return {
            ...skill,
            providerReady,
            disabledReason,
          };
        }),
      };
    },

    onSkillsUpdate: ({ skillId, enabled }) => {
      if (!options.skillRegistry) {
        return { success: false, message: 'Skills runtime is not available.' };
      }
      const updated = enabled ? options.skillRegistry.enable(skillId) : options.skillRegistry.disable(skillId);
      if (!updated) {
        return { success: false, message: `Skill '${skillId}' was not found.` };
      }
      const listDisabledSkillIds = () => options.skillRegistry!.listStatus()
        .filter((skill) => !skill.enabled)
        .map((skill) => skill.id);

      options.configRef.current.assistant.skills.disabledSkills = listDisabledSkillIds();
      const persisted = options.persistSkillsState();
      if (!persisted.success) {
        if (enabled) {
          options.skillRegistry.disable(skillId);
        } else {
          options.skillRegistry.enable(skillId);
        }
        options.configRef.current.assistant.skills.disabledSkills = listDisabledSkillIds();
        return { success: false, message: persisted.message };
      }
      return {
        success: true,
        message: enabled
          ? `Skill '${skillId}' enabled and persisted to config.`
          : `Skill '${skillId}' disabled and persisted to config.`,
      };
    },

    onToolsRun: async (input) => {
      const resolvedChannel = input.channel?.trim() || 'web';
      const channelUserId = input.userId?.trim() || `${resolvedChannel}-user`;
      const canonicalUserId = (resolvedChannel === 'code-session' && channelUserId.startsWith('code-session:'))
        ? channelUserId
        : options.identity.resolveCanonicalUserId(resolvedChannel, channelUserId);
      const requestedCodeContext = options.readCodeRequestMetadata(input.metadata);
      let resolvedCodeContext = requestedCodeContext?.workspaceRoot
        ? {
            workspaceRoot: requestedCodeContext.workspaceRoot,
            ...(requestedCodeContext.sessionId ? { sessionId: requestedCodeContext.sessionId } : {}),
          }
        : undefined;
      if (requestedCodeContext?.sessionId) {
        const resolvedSession = options.codeSessionStore.resolveForRequest({
          requestedSessionId: requestedCodeContext.sessionId,
          userId: canonicalUserId,
          principalId: input.principalId ?? input.userId,
          channel: resolvedChannel,
          surfaceId: options.getCodeSessionSurfaceId({
            surfaceId: input.surfaceId ?? options.readMessageSurfaceId(input.metadata),
            userId: canonicalUserId,
            principalId: input.principalId ?? input.userId,
          }),
          touchAttachment: false,
        });
        if (resolvedSession) {
          resolvedCodeContext = {
            sessionId: resolvedSession.session.id,
            workspaceRoot: resolvedSession.session.resolvedRoot,
          };
        }
      }
      const result = await options.toolExecutor.runTool({
        toolName: input.toolName,
        args: input.args ?? {},
        origin: input.origin ?? 'web',
        agentId: input.agentId ?? (
          options.configRef.current.channels.web?.defaultAgent
          ?? options.configRef.current.channels.cli?.defaultAgent
        ),
        userId: canonicalUserId,
        surfaceId: input.surfaceId ?? options.readMessageSurfaceId(input.metadata),
        principalId: input.principalId ?? input.userId,
        principalRole: input.principalRole ?? 'owner',
        contentTrustLevel: input.contentTrustLevel,
        taintReasons: input.taintReasons,
        derivedFromTaintedContent: input.derivedFromTaintedContent,
        scheduleId: input.scheduleId,
        channel: input.channel,
        codeContext: resolvedCodeContext,
      });
      options.trackToolRunAnalytics(input, result);
      return result;
    },

    onToolsPreflight: async ({ tools, requests }) => {
      const inputs = Array.isArray(requests) && requests.length > 0 ? requests : (tools ?? []);
      const results = await options.toolExecutor.preflightTools(inputs);
      const policy = options.toolExecutor.getPolicy();
      return {
        results,
        policy: {
          mode: policy.mode,
          allowedPaths: [...policy.sandbox.allowedPaths],
          allowedCommands: [...policy.sandbox.allowedCommands],
          allowedDomains: [...policy.sandbox.allowedDomains],
        },
      };
    },

    onToolsPolicyUpdate: (input) => {
      const policy = options.toolExecutor.updatePolicy(input);
      options.configRef.current.assistant.tools = {
        ...options.configRef.current.assistant.tools,
        policyMode: policy.mode,
        toolPolicies: { ...policy.toolPolicies },
        allowedPaths: [...policy.sandbox.allowedPaths],
        allowedCommands: [...policy.sandbox.allowedCommands],
        allowedDomains: [...policy.sandbox.allowedDomains],
      };
      const persisted = options.persistToolsState(policy);
      if (!persisted.success) {
        return { success: false, message: persisted.message };
      }
      options.trackSystemAnalytics('tool_policy_updated', {
        mode: policy.mode,
        paths: policy.sandbox.allowedPaths.length,
        commands: policy.sandbox.allowedCommands.length,
        domains: policy.sandbox.allowedDomains.length,
      });
      return {
        success: true,
        message: 'Tool policy updated and applied live (no restart required).',
        policy,
      };
    },

    onBrowserConfigState: () => {
      const browser = options.configRef.current.assistant.tools.browser;
      return {
        enabled: browser?.enabled ?? true,
        allowedDomains: browser?.allowedDomains ?? options.configRef.current.assistant.tools.allowedDomains ?? [],
        playwrightEnabled: browser?.playwrightEnabled ?? true,
        playwrightBrowser: browser?.playwrightBrowser ?? 'chromium',
        playwrightCaps: browser?.playwrightCaps ?? 'network,storage',
      };
    },

    onBrowserConfigUpdate: async (input) => {
      const current = options.configRef.current.assistant.tools.browser ?? { enabled: true };
      const updated = {
        enabled: input.enabled ?? current.enabled ?? true,
        allowedDomains: input.allowedDomains ?? current.allowedDomains,
        playwrightEnabled: input.playwrightEnabled ?? current.playwrightEnabled ?? true,
        playwrightBrowser: (input.playwrightBrowser ?? current.playwrightBrowser ?? 'chromium') as BrowserConfig['playwrightBrowser'],
        playwrightCaps: input.playwrightCaps ?? current.playwrightCaps ?? 'network,storage',
        playwrightArgs: current.playwrightArgs,
      };
      options.configRef.current.assistant.tools.browser = updated;
      const persisted = options.persistToolsState(options.toolExecutor.getPolicy());
      if (!persisted.success) {
        return { success: false, message: persisted.message };
      }
      const liveResult = await options.applyBrowserRuntimeConfig(options.configRef.current.assistant.tools.browser);
      options.trackSystemAnalytics('browser_config_updated', {
        enabled: updated.enabled,
        liveApplied: liveResult.success,
      });
      return liveResult;
    },

    onToolsApprovalDecision: async (input) => options.decideDashboardToolApproval(input),

    onToolsCategories: () => options.toolExecutor.getCategoryInfo(),

    onToolsCategoryToggle: (input) => {
      const { category, enabled } = input;
      options.toolExecutor.setCategoryEnabled(category, enabled);
      const disabled = options.toolExecutor.getDisabledCategories();
      options.configRef.current.assistant.tools.disabledCategories = disabled;
      const persisted = options.persistToolsState(options.toolExecutor.getPolicy());
      if (!persisted.success) {
        return { success: false, message: persisted.message };
      }
      options.trackSystemAnalytics('tool_category_toggled', { category, enabled });
      return {
        success: true,
        message: `Category '${category}' ${enabled ? 'enabled' : 'disabled'}.`,
      };
    },

    onToolsProviderRoutingUpdate: (input) => {
      if (typeof input.enabled === 'boolean') {
        options.configRef.current.assistant.tools.providerRoutingEnabled = input.enabled;
      }

      if (input.routing) {
        const validValues = new Set(['local', 'external', 'default']);
        const routing: Record<string, 'local' | 'external' | 'default'> = {};
        for (const [key, value] of Object.entries(input.routing)) {
          if (!validValues.has(value as string)) {
            return { success: false, message: `Invalid routing value '${value}' for '${key}'. Must be local, external, or default.` };
          }
          if (value !== 'default') {
            routing[key] = value as 'local' | 'external' | 'default';
          }
        }
        options.configRef.current.assistant.tools.providerRouting = routing;
      }

      const persisted = options.persistToolsState(options.toolExecutor.getPolicy());
      if (!persisted.success) {
        return { success: false, message: persisted.message };
      }
      return { success: true, message: 'Provider routing updated.' };
    },
  };
}
