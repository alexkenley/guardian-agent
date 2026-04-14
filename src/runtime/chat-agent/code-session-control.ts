import { randomUUID } from 'node:crypto';

import type { AgentContext, AgentResponse, UserMessage } from '../../agent/types.js';
import {
  formatDirectCodeSessionLine,
  isRecord,
  toBoolean,
  toString,
} from '../../chat-agent-helpers.js';
import { resolveCodingBackendSessionTarget } from '../coding-backend-session-target.js';
import type { CodeSessionRecord, CodeSessionStore } from '../code-sessions.js';
import type { IntentGatewayDecision } from '../intent-gateway.js';
import type { PendingActionRecord } from '../pending-actions.js';
import { isWorkspaceSwitchPendingActionSatisfied } from '../pending-action-resume.js';

type CodeSessionResponse = { content: string; metadata?: Record<string, unknown> };

type CodeSessionToolResult = {
  success?: unknown;
  message?: unknown;
  error?: unknown;
  output?: unknown;
};

type CodeSessionToolExecutor = (
  toolName: string,
  args: Record<string, unknown>,
  message: UserMessage,
  ctx: AgentContext,
) => Promise<CodeSessionToolResult>;

type CodingTaskResumer = (
  message: UserMessage,
  ctx: AgentContext,
  userKey: string,
  decision?: IntentGatewayDecision,
  codeContext?: { sessionId?: string; workspaceRoot: string },
) => Promise<CodeSessionResponse | null>;

type OnMessageFn = (
  message: UserMessage,
  ctx: AgentContext,
) => Promise<AgentResponse>;

interface EnsureExplicitCodingTaskWorkspaceTargetInput {
  toolsEnabled: boolean;
  codeSessionStore?: Pick<CodeSessionStore, 'getSession' | 'listSessionsForUser'> | null;
  executeDirectCodeSessionTool: CodeSessionToolExecutor;
  message: UserMessage;
  ctx: AgentContext;
  decision?: IntentGatewayDecision;
  currentSession?: CodeSessionRecord | null;
  codeContext?: { workspaceRoot: string; sessionId?: string };
}

type EnsureExplicitCodingTaskWorkspaceTargetResult =
  | {
      status: 'unchanged';
    }
  | {
      status: 'switched';
      currentSession: CodeSessionRecord | null;
      codeContext: { workspaceRoot: string; sessionId: string };
      switchResponse: { content: string; metadata: Record<string, unknown> };
    }
  | {
      status: 'blocked';
      response: { content: string; metadata?: Record<string, unknown> };
    };

export async function ensureExplicitCodingTaskWorkspaceTarget(
  input: EnsureExplicitCodingTaskWorkspaceTargetInput,
): Promise<EnsureExplicitCodingTaskWorkspaceTargetResult> {
  const requestedSessionTarget = typeof input.decision?.entities.sessionTarget === 'string'
    ? input.decision.entities.sessionTarget.trim()
    : '';
  if (!input.decision
    || input.decision.route !== 'coding_task'
    || input.decision.resolution !== 'ready'
    || !requestedSessionTarget
    || !input.codeSessionStore
    || !input.toolsEnabled) {
    return { status: 'unchanged' };
  }

  const codeSessionOwnerUserId = input.currentSession?.ownerUserId ?? input.message.userId?.trim();
  if (!codeSessionOwnerUserId) {
    return { status: 'unchanged' };
  }

  const mentionedSessionResolution = resolveCodingBackendSessionTarget({
    requestedSessionTarget,
    currentSessionId: input.currentSession?.id ?? input.codeContext?.sessionId,
    sessions: input.codeSessionStore.listSessionsForUser(codeSessionOwnerUserId),
  });
  if (mentionedSessionResolution.status === 'none' || mentionedSessionResolution.status === 'current') {
    return { status: 'unchanged' };
  }
  if (mentionedSessionResolution.status === 'target_unresolved') {
    const lines = input.currentSession
      ? [
          'This chat is currently attached to:',
          formatDirectCodeSessionLine(input.currentSession, true),
        ]
      : ['This chat is not currently attached to a coding workspace.'];
    lines.push(`I couldn't match the coding workspace you mentioned: "${mentionedSessionResolution.requestedSessionTarget}".`);
    lines.push(mentionedSessionResolution.error);
    lines.push('I did not run the task in the wrong workspace.');
    return {
      status: 'blocked',
      response: {
        content: lines.join('\n'),
        metadata: input.currentSession
          ? {
              codeSessionResolved: true,
              codeSessionId: input.currentSession.id,
            }
          : undefined,
      },
    };
  }

  const attachResult = await input.executeDirectCodeSessionTool(
    'code_session_attach',
    { sessionId: mentionedSessionResolution.targetSession.id },
    input.message,
    input.ctx,
  );
  if (!toBoolean(attachResult.success)) {
    const failure = toString(attachResult.error)
      || toString(attachResult.message)
      || `I could not switch this chat to "${mentionedSessionResolution.targetSession.title}".`;
    return { status: 'blocked', response: { content: failure } };
  }

  const attachedSession = isRecord(attachResult.output) && isRecord(attachResult.output.session)
    ? attachResult.output.session
    : mentionedSessionResolution.targetSession;
  const sessionId = toString(attachedSession.id).trim() || mentionedSessionResolution.targetSession.id;
  const workspaceRoot = toString(attachedSession.resolvedRoot).trim()
    || toString(attachedSession.workspaceRoot).trim()
    || toString(mentionedSessionResolution.targetSession.resolvedRoot).trim()
    || mentionedSessionResolution.targetSession.workspaceRoot;
  const currentSession = input.codeSessionStore.getSession(sessionId, codeSessionOwnerUserId)
    ?? input.codeSessionStore.getSession(sessionId);
  return {
    status: 'switched',
    currentSession,
    codeContext: {
      sessionId,
      workspaceRoot,
    },
    switchResponse: {
      content: `Switched this chat to:\n${formatDirectCodeSessionLine(attachedSession, true)}`,
      metadata: {
        codeSessionResolved: true,
        codeSessionId: sessionId,
        codeSessionFocusChanged: true,
      },
    },
  };
}

function buildPendingActionResumeDecision(
  pendingAction: PendingActionRecord | null | undefined,
): IntentGatewayDecision | undefined {
  if (!pendingAction || pendingAction.intent.route !== 'coding_task') {
    return undefined;
  }
  const entities = isRecord(pendingAction.intent.entities)
    ? pendingAction.intent.entities
    : {};
  const uiSurface = toString(entities.uiSurface);
  const emailProvider = toString(entities.emailProvider);
  const operation = pendingAction.intent.operation === 'inspect' ? 'inspect' : 'run';
  const preferredTier = typeof entities.codingBackend === 'string' && entities.codingBackend.trim()
    ? 'local'
    : operation === 'inspect'
      ? 'external'
      : 'local';
  return {
    route: 'coding_task',
    confidence: 'high',
    operation,
    summary: pendingAction.intent.summary?.trim() || 'Resume the pending coding task.',
    turnRelation: 'follow_up',
    resolution: 'ready',
    missingFields: [],
    executionClass: 'repo_grounded',
    preferredTier,
    requiresRepoGrounding: true,
    requiresToolSynthesis: true,
    expectedContextPressure: operation === 'inspect' ? 'high' : 'medium',
    preferredAnswerPath: operation === 'inspect' ? 'chat_synthesis' : 'tool_loop',
    resolvedContent: pendingAction.intent.originalUserContent?.trim() || undefined,
    entities: {
      ...(typeof entities.automationName === 'string' ? { automationName: entities.automationName } : {}),
      ...(typeof entities.manualOnly === 'boolean' ? { manualOnly: entities.manualOnly } : {}),
      ...(typeof entities.scheduled === 'boolean' ? { scheduled: entities.scheduled } : {}),
      ...(typeof entities.enabled === 'boolean' ? { enabled: entities.enabled } : {}),
      ...((uiSurface === 'automations' || uiSurface === 'system' || uiSurface === 'dashboard' || uiSurface === 'config' || uiSurface === 'chat' || uiSurface === 'unknown')
        ? { uiSurface }
        : {}),
      ...(Array.isArray(entities.urls) ? { urls: entities.urls.filter((value): value is string => typeof value === 'string') } : {}),
      ...(typeof entities.query === 'string' ? { query: entities.query } : {}),
      ...(typeof entities.path === 'string' ? { path: entities.path } : {}),
      ...(typeof entities.sessionTarget === 'string' ? { sessionTarget: entities.sessionTarget } : {}),
      ...((emailProvider === 'gws' || emailProvider === 'm365') ? { emailProvider } : {}),
      ...(typeof entities.codingBackend === 'string' ? { codingBackend: entities.codingBackend } : {}),
      ...(typeof entities.codingBackendRequested === 'boolean' ? { codingBackendRequested: entities.codingBackendRequested } : {}),
      ...(typeof entities.codingRunStatusCheck === 'boolean' ? { codingRunStatusCheck: entities.codingRunStatusCheck } : {}),
    },
  };
}

async function tryResumePendingActionAfterWorkspaceSwitch(input: {
  message: UserMessage;
  ctx: AgentContext;
  sessionId: string;
  codeContext: { sessionId: string; workspaceRoot?: string };
  switchResponse: { content: string; metadata?: Record<string, unknown> };
  pendingActionOverride?: PendingActionRecord | null;
  getActivePendingAction: (
    userId: string,
    channel: string,
    surfaceId?: string,
  ) => PendingActionRecord | null;
  completePendingAction: (actionId: string) => void;
  resumeCodingTask: CodingTaskResumer;
  onMessage: OnMessageFn;
}): Promise<CodeSessionResponse | null> {
  const pendingAction = input.pendingActionOverride
    ?? input.getActivePendingAction(input.message.userId, input.message.channel, input.message.surfaceId);
  if (!isWorkspaceSwitchPendingActionSatisfied(pendingAction, input.sessionId)) {
    return null;
  }
  const originalUserContent = pendingAction?.intent.originalUserContent?.trim();
  if (!originalUserContent) {
    if (pendingAction) input.completePendingAction(pendingAction.id);
    return null;
  }
  if (pendingAction) {
    input.completePendingAction(pendingAction.id);
  }
  const resumedDecision = buildPendingActionResumeDecision(pendingAction);
  const resumed = resumedDecision
    ? await input.resumeCodingTask(
        {
          ...input.message,
          id: randomUUID(),
          content: originalUserContent,
        },
        input.ctx,
        `${input.message.userId}:${input.message.channel}`,
        resumedDecision,
        input.codeContext.workspaceRoot
          ? {
              sessionId: input.codeContext.sessionId,
              workspaceRoot: input.codeContext.workspaceRoot,
            }
          : undefined,
      ) ?? await input.onMessage(
        {
          ...input.message,
          id: randomUUID(),
          content: originalUserContent,
        },
        input.ctx,
      )
    : await input.onMessage(
      {
        ...input.message,
        id: randomUUID(),
        content: originalUserContent,
      },
      input.ctx,
    );
  return {
    content: `${input.switchResponse.content}\n\n${resumed.content}`,
    metadata: {
      ...(input.switchResponse.metadata ?? {}),
      ...(resumed.metadata ?? {}),
    },
  };
}

async function handleCodeSessionCurrent(input: {
  executeDirectCodeSessionTool: CodeSessionToolExecutor;
  message: UserMessage;
  ctx: AgentContext;
}): Promise<CodeSessionResponse> {
  const result = await input.executeDirectCodeSessionTool('code_session_current', {}, input.message, input.ctx);
  if (!toBoolean(result.success)) {
    const failure = toString(result.message) || 'I could not inspect the current coding workspace.';
    return { content: failure };
  }
  const session = isRecord(result.output) && isRecord(result.output.session) ? result.output.session : null;
  if (!session) {
    return { content: 'This chat is not currently attached to any coding workspace.' };
  }
  return {
    content: [
      'This chat is currently attached to:',
      formatDirectCodeSessionLine(session, true),
    ].join('\n'),
    metadata: {
      codeSessionResolved: true,
      codeSessionId: toString(session.id),
    },
  };
}

async function handleCodeSessionList(input: {
  executeDirectCodeSessionTool: CodeSessionToolExecutor;
  message: UserMessage;
  ctx: AgentContext;
}): Promise<CodeSessionResponse> {
  const [listResult, currentResult] = await Promise.all([
    input.executeDirectCodeSessionTool('code_session_list', { limit: 20 }, input.message, input.ctx),
    input.executeDirectCodeSessionTool('code_session_current', {}, input.message, input.ctx),
  ]);
  if (!toBoolean(listResult.success)) {
    const failure = toString(listResult.message) || 'I could not list coding workspaces.';
    return { content: failure };
  }
  const sessions = isRecord(listResult.output) && Array.isArray(listResult.output.sessions)
    ? listResult.output.sessions.filter((session) => isRecord(session))
    : [];
  const currentSession = isRecord(currentResult.output) && isRecord(currentResult.output.session)
    ? currentResult.output.session
    : null;
  const currentSessionId = currentSession ? toString(currentSession.id) : '';

  if (sessions.length === 0) {
    if (currentSession) {
      return {
        content: [
          'No owned coding workspaces were listed for this chat, but the surface is currently attached to:',
          formatDirectCodeSessionLine(currentSession, true),
        ].join('\n'),
        metadata: {
          codeSessionResolved: true,
          codeSessionId: currentSessionId,
        },
      };
    }
    return { content: 'No coding workspaces are currently available for this chat.' };
  }

  const lines = ['Available coding workspaces:'];
  for (const session of sessions) {
    lines.push(formatDirectCodeSessionLine(session, toString(session.id) === currentSessionId));
  }
  return {
    content: lines.join('\n'),
    metadata: currentSessionId
      ? {
          codeSessionResolved: true,
          codeSessionId: currentSessionId,
        }
      : undefined,
  };
}

async function handleCodeSessionDetach(input: {
  executeDirectCodeSessionTool: CodeSessionToolExecutor;
  message: UserMessage;
  ctx: AgentContext;
}): Promise<CodeSessionResponse> {
  const result = await input.executeDirectCodeSessionTool('code_session_detach', {}, input.message, input.ctx);
  if (!toBoolean(result.success)) {
    const failure = toString(result.message) || 'I could not detach this chat from the current coding workspace.';
    return { content: failure };
  }
  const detached = isRecord(result.output) ? toBoolean(result.output.detached) : false;
  return {
    content: detached
      ? 'Detached this chat from the current coding workspace.'
      : 'This chat was not attached to a coding workspace.',
    metadata: {
      codeSessionFocusChanged: true,
      codeSessionDetached: true,
    },
  };
}

async function handleCodeSessionCreate(input: {
  executeDirectCodeSessionTool: CodeSessionToolExecutor;
  message: UserMessage;
  ctx: AgentContext;
  target: string;
}): Promise<CodeSessionResponse> {
  if (!input.target.trim()) {
    return { content: 'Please specify the workspace path or name for the new coding session.' };
  }
  const parts = input.target.split('|').map((part) => part.trim());
  const workspaceRoot = parts[0];
  const title = parts[1] || undefined;
  const result = await input.executeDirectCodeSessionTool(
    'code_session_create',
    { workspaceRoot, ...(title ? { title } : {}), attach: true },
    input.message,
    input.ctx,
  );
  if (!toBoolean(result.success)) {
    const failure = toString(result.error) || toString(result.message) || `Could not create coding session for "${input.target}".`;
    return { content: failure };
  }
  const session = isRecord(result.output) && isRecord(result.output.session)
    ? result.output.session
    : null;
  if (!session) {
    return {
      content: `Created and attached to a new coding session for ${workspaceRoot}.`,
      metadata: { codeSessionFocusChanged: true },
    };
  }
  return {
    content: `Created and attached to:\n${formatDirectCodeSessionLine(session, true)}`,
    metadata: {
      codeSessionResolved: true,
      codeSessionId: toString(session.id),
      codeSessionFocusChanged: true,
    },
  };
}

export async function handleCodeSessionAttach(input: {
  executeDirectCodeSessionTool: CodeSessionToolExecutor;
  getActivePendingAction: (
    userId: string,
    channel: string,
    surfaceId?: string,
  ) => PendingActionRecord | null;
  completePendingAction: (actionId: string) => void;
  resumeCodingTask: CodingTaskResumer;
  onMessage: OnMessageFn;
  message: UserMessage;
  ctx: AgentContext;
  target: string;
}): Promise<CodeSessionResponse> {
  if (!input.target.trim()) {
    return { content: 'Please specify which coding session or workspace to switch to.' };
  }
  const currentResult = await input.executeDirectCodeSessionTool('code_session_current', {}, input.message, input.ctx);
  const currentSession = isRecord(currentResult.output) && isRecord(currentResult.output.session)
    ? currentResult.output.session
    : null;
  const pendingActionBeforeAttach = input.getActivePendingAction(
    input.message.userId,
    input.message.channel,
    input.message.surfaceId,
  );
  const attachResult = await input.executeDirectCodeSessionTool(
    'code_session_attach',
    { sessionId: input.target },
    input.message,
    input.ctx,
  );
  if (!toBoolean(attachResult.success)) {
    const failure = toString(attachResult.error) || toString(attachResult.message) || `No coding workspace matched "${input.target}".`;
    return { content: failure };
  }

  const session = isRecord(attachResult.output) && isRecord(attachResult.output.session)
    ? attachResult.output.session
    : null;
  if (!session) {
    return {
      content: 'Attached this chat to the requested coding workspace.',
      metadata: { codeSessionFocusChanged: true },
    };
  }

  const sessionId = toString(session.id);
  const alreadyAttached = currentSession && toString(currentSession.id) === sessionId;
  const resumePendingWorkspaceSwitch = isWorkspaceSwitchPendingActionSatisfied(pendingActionBeforeAttach, sessionId);
  const response = {
    content: alreadyAttached && !resumePendingWorkspaceSwitch
      ? `This chat is already attached to:\n${formatDirectCodeSessionLine(session, true)}`
      : `Switched this chat to:\n${formatDirectCodeSessionLine(session, true)}`,
    metadata: {
      codeSessionResolved: true,
      codeSessionId: sessionId,
      codeSessionFocusChanged: true,
    },
  };
  const resumed = await tryResumePendingActionAfterWorkspaceSwitch({
    message: input.message,
    ctx: input.ctx,
    sessionId,
    codeContext: {
      sessionId,
      workspaceRoot: toString(session.resolvedRoot) || toString(session.workspaceRoot),
    },
    switchResponse: response,
    pendingActionOverride: pendingActionBeforeAttach,
    getActivePendingAction: input.getActivePendingAction,
    completePendingAction: input.completePendingAction,
    resumeCodingTask: input.resumeCodingTask,
    onMessage: input.onMessage,
  });
  return resumed ?? response;
}

export async function tryDirectCodeSessionControlFromGateway(input: {
  toolsEnabled: boolean;
  executeDirectCodeSessionTool: CodeSessionToolExecutor;
  getActivePendingAction: (
    userId: string,
    channel: string,
    surfaceId?: string,
  ) => PendingActionRecord | null;
  completePendingAction: (actionId: string) => void;
  resumeCodingTask: CodingTaskResumer;
  onMessage: OnMessageFn;
  message: UserMessage;
  ctx: AgentContext;
  decision?: IntentGatewayDecision;
}): Promise<CodeSessionResponse | null> {
  if (!input.toolsEnabled) return null;
  if (!input.decision || input.decision.route !== 'coding_session_control') return null;

  const operation = input.decision.operation;

  if (operation === 'navigate' || operation === 'search' || operation === 'read') {
    return handleCodeSessionList(input);
  }
  if (operation === 'inspect') {
    return handleCodeSessionCurrent(input);
  }
  if (operation === 'delete') {
    return handleCodeSessionDetach(input);
  }
  if (operation === 'update') {
    const target = input.decision.entities.sessionTarget || input.decision.entities.query || '';
    if (!target.trim()) {
      return { content: 'Please specify which coding session or workspace to switch to.' };
    }
    return handleCodeSessionAttach({
      ...input,
      target,
    });
  }
  if (operation === 'create') {
    const target = input.decision.entities.sessionTarget || input.decision.entities.path || input.decision.entities.query || '';
    if (!target.trim()) {
      return { content: 'Please specify the workspace path or name for the new coding session.' };
    }
    return handleCodeSessionCreate({
      ...input,
      target,
    });
  }

  return handleCodeSessionList(input);
}
