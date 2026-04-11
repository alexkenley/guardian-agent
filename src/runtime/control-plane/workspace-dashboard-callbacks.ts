import type {
  DashboardCallbacks,
  DashboardCodeSessionSnapshot,
} from '../../channels/web-types.js';
import type { ConversationService } from '../conversation.js';
import { MAX_CODE_SESSIONS_PER_USER } from '../code-sessions.js';
import type { CodeSessionRecord, CodeSessionStore } from '../code-sessions.js';
import type { IdentityService } from '../identity.js';
import type { RunTimelineStore } from '../run-timeline.js';

type WorkspaceDashboardCallbacks = Pick<
  DashboardCallbacks,
  | 'onCodeSessionsList'
  | 'onCodeSessionGet'
  | 'onCodeSessionTimeline'
  | 'onCodeSessionCreate'
  | 'onCodeSessionUpdate'
  | 'onCodeSessionDelete'
  | 'onCodeSessionAttach'
  | 'onCodeSessionDetach'
  | 'onCodeSessionSetReferences'
  | 'onCodeSessionSetTarget'
  | 'onCodeSessionApprovalDecision'
  | 'onCodeSessionResetConversation'
  | 'onConversationReset'
  | 'onConversationSessions'
  | 'onConversationUseSession'
>;

type ToolApprovalDecisionInput = Parameters<NonNullable<DashboardCallbacks['onToolsApprovalDecision']>>[0];

interface ResolveDashboardCodeSessionRequestResult {
  resolvedChannel: string;
  resolvedSurfaceId: string;
  canonicalUserId: string;
  resolvedSession: ReturnType<CodeSessionStore['resolveForRequest']>;
}

interface WorkspaceDashboardCallbackOptions {
  codeSessionStore: CodeSessionStore;
  identity: IdentityService;
  conversations: ConversationService;
  runTimeline: RunTimelineStore;
  refreshRunTimelineSnapshots: () => void;
  maybeScheduleCodeSession: (session: CodeSessionRecord) => CodeSessionRecord;
  hydrateCodeSessionRuntimeState: (session: CodeSessionRecord) => CodeSessionRecord;
  buildCodeSessionSnapshot: (
    session: CodeSessionRecord,
    options?: {
      ownerUserId?: string;
      principalId?: string;
      channel?: string;
      surfaceId?: string;
      historyLimit?: number;
    },
  ) => DashboardCodeSessionSnapshot;
  getCodeSessionSurfaceId: (args: { surfaceId?: string; userId?: string; principalId?: string }) => string;
  resetCodeSessionWorkspacePolicy: () => void;
  reconcileConfiguredAllowedPaths: () => void;
  approvalBelongsToCodeSession: (approvalId: string, sessionId: string) => boolean;
  resolveDashboardCodeSessionRequest: (args: {
    sessionId: string;
    userId?: string;
    principalId?: string;
    channel?: string;
    surfaceId?: string;
    touchAttachment?: boolean;
  }) => ResolveDashboardCodeSessionRequestResult;
  decideDashboardToolApproval: (input: ToolApprovalDecisionInput) => ReturnType<NonNullable<DashboardCallbacks['onToolsApprovalDecision']>>;
  createStructuredRequestError: (message: string, statusCode: number, errorCode: string) => Error;
  getCodeSessionConversationKey: (session: CodeSessionRecord) => {
    agentId: string;
    userId: string;
    channel: string;
  };
  resolveSharedStateAgentId: (agentId?: string) => string | undefined;
  trackConversationReset: (input: {
    agentId: string;
    channel: string;
    channelUserId: string;
    canonicalUserId: string;
  }) => void;
}

export function createWorkspaceDashboardCallbacks(
  options: WorkspaceDashboardCallbackOptions,
): WorkspaceDashboardCallbacks {
  const buildCodeSessionsList = (args: {
    canonicalUserId: string;
    principalId?: string;
    channel: string;
    surfaceId: string;
  }) => {
    const sessions = options.codeSessionStore
      .listSessionsForUser(args.canonicalUserId)
      .map((session) => options.hydrateCodeSessionRuntimeState(session));
    const current = options.codeSessionStore.resolveForRequest({
      userId: args.canonicalUserId,
      principalId: args.principalId,
      channel: args.channel,
      surfaceId: args.surfaceId,
      touchAttachment: false,
    });
    const referencedSessionIds = options.codeSessionStore.listReferencedSessionIdsForSurface({
      userId: args.canonicalUserId,
      principalId: args.principalId,
      channel: args.channel,
      surfaceId: args.surfaceId,
    });
    const targetSessionId = options.codeSessionStore.getTargetSessionIdForSurface({
      userId: args.canonicalUserId,
      principalId: args.principalId,
      channel: args.channel,
      surfaceId: args.surfaceId,
    });
    return {
      sessions,
      currentSessionId: current?.session.id ?? null,
      referencedSessionIds,
      targetSessionId,
    };
  };

  return {
    onCodeSessionsList: ({ userId, principalId, channel, surfaceId }) => {
      const resolvedChannel = channel?.trim() || 'web';
      const channelUserId = userId?.trim() || `${resolvedChannel}-user`;
      const canonicalUserId = options.identity.resolveCanonicalUserId(resolvedChannel, channelUserId);
      return buildCodeSessionsList({
        canonicalUserId,
        principalId,
        channel: resolvedChannel,
        surfaceId: surfaceId?.trim() || options.getCodeSessionSurfaceId({ userId: canonicalUserId, principalId }),
      });
    },

    onCodeSessionGet: ({ sessionId, userId, principalId, channel, surfaceId, historyLimit }) => {
      const resolvedChannel = channel?.trim() || 'web';
      const channelUserId = userId?.trim() || `${resolvedChannel}-user`;
      const canonicalUserId = options.identity.resolveCanonicalUserId(resolvedChannel, channelUserId);
      const session = options.codeSessionStore.getSession(sessionId, canonicalUserId);
      if (!session) return null;
      const enrichedSession = options.maybeScheduleCodeSession(session);
      return options.buildCodeSessionSnapshot(enrichedSession, {
        ownerUserId: canonicalUserId,
        principalId,
        channel: resolvedChannel,
        surfaceId: surfaceId?.trim() || options.getCodeSessionSurfaceId({ userId: canonicalUserId, principalId }),
        historyLimit,
      });
    },

    onCodeSessionTimeline: ({ sessionId, userId, channel, principalId: _principalId, limit }) => {
      const resolvedChannel = channel?.trim() || 'web';
      const channelUserId = userId?.trim() || `${resolvedChannel}-user`;
      const canonicalUserId = options.identity.resolveCanonicalUserId(resolvedChannel, channelUserId);
      const session = options.codeSessionStore.getSession(sessionId, canonicalUserId);
      if (!session) return null;
      const hydrated = options.hydrateCodeSessionRuntimeState(session);
      options.refreshRunTimelineSnapshots();
      return {
        codeSessionId: hydrated.id,
        runs: options.runTimeline.listRunsForCodeSession(hydrated.id, limit ?? 12),
      };
    },

    onCodeSessionCreate: ({ userId, principalId, channel, surfaceId, title, workspaceRoot, agentId, attach }) => {
      const resolvedChannel = channel?.trim() || 'web';
      const channelUserId = userId?.trim() || `${resolvedChannel}-user`;
      const canonicalUserId = options.identity.resolveCanonicalUserId(resolvedChannel, channelUserId);
      let created: CodeSessionRecord;
      try {
        created = options.codeSessionStore.createSession({
          ownerUserId: canonicalUserId,
          ownerPrincipalId: principalId ?? canonicalUserId,
          title,
          workspaceRoot,
          agentId: agentId?.trim() || null,
        });
      } catch (err) {
        if ((err as { code?: unknown })?.code === 'CODE_SESSION_LIMIT_REACHED') {
          throw options.createStructuredRequestError(
            err instanceof Error
              ? err.message
              : `Guardian keeps the coding workspace portfolio capped at ${MAX_CODE_SESSIONS_PER_USER} sessions. Remove a session before adding another.`,
            409,
            'CODE_SESSION_LIMIT_REACHED',
          );
        }
        throw err;
      }
      const session = options.maybeScheduleCodeSession(created);
      options.resetCodeSessionWorkspacePolicy();
      if (attach !== false) {
        options.codeSessionStore.attachSession({
          sessionId: session.id,
          userId: canonicalUserId,
          principalId,
          channel: resolvedChannel,
          surfaceId: surfaceId?.trim() || options.getCodeSessionSurfaceId({ userId: canonicalUserId, principalId }),
          mode: 'controller',
        });
      }
      return options.buildCodeSessionSnapshot(session, {
        ownerUserId: canonicalUserId,
        principalId,
        channel: resolvedChannel,
        surfaceId: surfaceId?.trim() || options.getCodeSessionSurfaceId({ userId: canonicalUserId, principalId }),
      });
    },

    onCodeSessionUpdate: ({ sessionId, userId, principalId, channel, surfaceId, title, workspaceRoot, agentId, uiState, workState, status }) => {
      const resolvedChannel = channel?.trim() || 'web';
      const channelUserId = userId?.trim() || `${resolvedChannel}-user`;
      const canonicalUserId = options.identity.resolveCanonicalUserId(resolvedChannel, channelUserId);
      const updated = options.codeSessionStore.updateSession({
        sessionId,
        ownerUserId: canonicalUserId,
        ...(title !== undefined ? { title } : {}),
        ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
        ...(agentId !== undefined ? { agentId } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(uiState ? { uiState } : {}),
        ...(workState ? { workState } : {}),
      });
      if (!updated) return null;
      const enrichedUpdated = options.maybeScheduleCodeSession(updated);
      return options.buildCodeSessionSnapshot(enrichedUpdated, {
        ownerUserId: canonicalUserId,
        principalId,
        channel: resolvedChannel,
        surfaceId: surfaceId?.trim() || options.getCodeSessionSurfaceId({ userId: canonicalUserId, principalId }),
      });
    },

    onCodeSessionDelete: ({ sessionId, userId, principalId, channel, surfaceId }) => {
      const resolvedChannel = channel?.trim() || 'web';
      const channelUserId = userId?.trim() || `${resolvedChannel}-user`;
      const canonicalUserId = options.identity.resolveCanonicalUserId(resolvedChannel, channelUserId);
      const deleted = options.codeSessionStore.deleteSession(sessionId, canonicalUserId);
      options.resetCodeSessionWorkspacePolicy();
      const current = options.codeSessionStore.resolveForRequest({
        userId: canonicalUserId,
        principalId,
        channel: resolvedChannel,
        surfaceId: surfaceId?.trim() || options.getCodeSessionSurfaceId({ userId: canonicalUserId, principalId }),
        touchAttachment: false,
      });
      return {
        success: deleted,
        currentSessionId: current?.session.id ?? null,
      };
    },

    onCodeSessionAttach: ({ sessionId, userId, principalId, channel, surfaceId, mode }) => {
      const resolvedChannel = channel?.trim() || 'web';
      const channelUserId = userId?.trim() || `${resolvedChannel}-user`;
      const canonicalUserId = options.identity.resolveCanonicalUserId(resolvedChannel, channelUserId);
      const attachment = options.codeSessionStore.attachSession({
        sessionId,
        userId: canonicalUserId,
        principalId,
        channel: resolvedChannel,
        surfaceId: surfaceId?.trim() || options.getCodeSessionSurfaceId({ userId: canonicalUserId, principalId }),
        mode,
      });
      const session = options.codeSessionStore.getSession(sessionId, canonicalUserId);
      options.reconcileConfiguredAllowedPaths();
      return {
        success: !!attachment && !!session,
        ...(session
          ? {
              snapshot: options.buildCodeSessionSnapshot(session, {
                ownerUserId: canonicalUserId,
                principalId,
                channel: resolvedChannel,
                surfaceId: surfaceId?.trim() || options.getCodeSessionSurfaceId({ userId: canonicalUserId, principalId }),
              }),
            }
          : {}),
      };
    },

    onCodeSessionDetach: ({ userId, principalId, channel, surfaceId }) => {
      const resolvedChannel = channel?.trim() || 'web';
      const channelUserId = userId?.trim() || `${resolvedChannel}-user`;
      const canonicalUserId = options.identity.resolveCanonicalUserId(resolvedChannel, channelUserId);
      const success = options.codeSessionStore.detachSession({
        userId: canonicalUserId,
        principalId,
        channel: resolvedChannel,
        surfaceId: surfaceId?.trim() || options.getCodeSessionSurfaceId({ userId: canonicalUserId, principalId }),
      });
      options.reconcileConfiguredAllowedPaths();
      return {
        success,
      };
    },

    onCodeSessionSetReferences: ({ userId, principalId, channel, surfaceId, referencedSessionIds }) => {
      const resolvedChannel = channel?.trim() || 'web';
      const channelUserId = userId?.trim() || `${resolvedChannel}-user`;
      const canonicalUserId = options.identity.resolveCanonicalUserId(resolvedChannel, channelUserId);
      const resolvedSurfaceId = surfaceId?.trim() || options.getCodeSessionSurfaceId({ userId: canonicalUserId, principalId });
      options.codeSessionStore.setReferencedSessionsForSurface({
        userId: canonicalUserId,
        principalId,
        channel: resolvedChannel,
        surfaceId: resolvedSurfaceId,
        referencedSessionIds,
      });
      return buildCodeSessionsList({
        canonicalUserId,
        principalId,
        channel: resolvedChannel,
        surfaceId: resolvedSurfaceId,
      });
    },

    onCodeSessionSetTarget: ({ userId, principalId, channel, surfaceId, targetSessionId }) => {
      const resolvedChannel = channel?.trim() || 'web';
      const channelUserId = userId?.trim() || `${resolvedChannel}-user`;
      const canonicalUserId = options.identity.resolveCanonicalUserId(resolvedChannel, channelUserId);
      const resolvedSurfaceId = surfaceId?.trim() || options.getCodeSessionSurfaceId({ userId: canonicalUserId, principalId });
      options.codeSessionStore.setTargetSessionForSurface({
        userId: canonicalUserId,
        principalId,
        channel: resolvedChannel,
        surfaceId: resolvedSurfaceId,
        targetSessionId,
      });
      return buildCodeSessionsList({
        canonicalUserId,
        principalId,
        channel: resolvedChannel,
        surfaceId: resolvedSurfaceId,
      });
    },

    onCodeSessionApprovalDecision: async ({ sessionId, approvalId, decision, userId, principalId, principalRole, channel, surfaceId, reason }) => {
      const resolved = options.resolveDashboardCodeSessionRequest({
        sessionId,
        userId,
        principalId,
        channel,
        surfaceId,
      });
      if (!resolved.resolvedSession) {
        throw options.createStructuredRequestError(
          `Code session '${sessionId}' is unavailable for this request.`,
          409,
          'CODE_SESSION_UNAVAILABLE',
        );
      }
      if (!options.approvalBelongsToCodeSession(approvalId, resolved.resolvedSession.session.id)) {
        throw options.createStructuredRequestError(
          `Approval '${approvalId}' was not found for code session '${resolved.resolvedSession.session.id}'.`,
          404,
          'CODE_SESSION_APPROVAL_NOT_FOUND',
        );
      }
      return options.decideDashboardToolApproval({
        approvalId,
        decision,
        actor: principalId ?? resolved.canonicalUserId,
        actorRole: principalRole ?? 'owner',
        userId: resolved.canonicalUserId,
        channel: resolved.resolvedChannel,
        surfaceId: resolved.resolvedSurfaceId,
        reason,
      });
    },

    onCodeSessionResetConversation: ({ sessionId, userId, channel }) => {
      const resolvedChannel = channel?.trim() || 'web';
      const channelUserId = userId?.trim() || `${resolvedChannel}-user`;
      const canonicalUserId = options.identity.resolveCanonicalUserId(resolvedChannel, channelUserId);
      const session = options.codeSessionStore.getSession(sessionId, canonicalUserId);
      if (!session) {
        return { success: false, message: `Code session '${sessionId}' was not found.` };
      }
      const removed = options.conversations.resetConversation(options.getCodeSessionConversationKey(session));
      return {
        success: true,
        message: removed
          ? `Conversation reset for coding session '${session.title}'.`
          : `No stored conversation found for coding session '${session.title}'.`,
      };
    },

    onConversationReset: async ({ agentId, userId, channel }) => {
      const canonicalUserId = options.identity.resolveCanonicalUserId(channel, userId);
      const stateAgentId = options.resolveSharedStateAgentId(agentId) ?? agentId;
      const removed = options.conversations.resetConversation({ agentId: stateAgentId, userId: canonicalUserId, channel });
      options.trackConversationReset({
        agentId,
        channel,
        channelUserId: userId,
        canonicalUserId,
      });
      return {
        success: true,
        message: removed
          ? `Conversation reset for '${agentId}'.`
          : `No stored conversation found for '${agentId}'.`,
      };
    },

    onConversationSessions: ({ userId, channel, agentId }) => {
      const canonicalUserId = options.identity.resolveCanonicalUserId(channel, userId);
      return options.conversations.listSessions(canonicalUserId, channel, options.resolveSharedStateAgentId(agentId) ?? agentId);
    },

    onConversationUseSession: ({ agentId, userId, channel, sessionId }) => {
      const canonicalUserId = options.identity.resolveCanonicalUserId(channel, userId);
      const ok = options.conversations.setActiveSession({
        agentId: options.resolveSharedStateAgentId(agentId) ?? agentId,
        userId: canonicalUserId,
        channel,
      }, sessionId);
      return {
        success: ok,
        message: ok
          ? `Switched to session '${sessionId}'.`
          : `Session '${sessionId}' was not found.`,
      };
    },
  };
}
