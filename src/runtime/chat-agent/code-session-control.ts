import { randomUUID } from 'node:crypto';

import type { AgentContext, AgentResponse, UserMessage } from '../../agent/types.js';
import {
  formatDirectCodeSessionLine,
  isRecord,
  toBoolean,
  toString,
} from '../../chat-agent-helpers.js';
import { resolveCodingBackendSessionTarget } from '../coding-backend-session-target.js';
import type { CodeSessionManagedSandbox, CodeSessionRecord, CodeSessionStore } from '../code-sessions.js';
import type { RemoteExecutionTargetDescriptor, RemoteExecutionTargetDiagnostic } from '../remote-execution/policy.js';
import type { IntentGatewayDecision } from '../intent-gateway.js';
import type { PendingActionRecord } from '../pending-actions.js';
import { isWorkspaceSwitchPendingActionSatisfied } from '../pending-action-resume.js';

export type CodeSessionResponse = { content: string; metadata?: Record<string, unknown> };

export type CodeSessionToolResult = {
  success?: unknown;
  message?: unknown;
  error?: unknown;
  output?: unknown;
};

export type CodeSessionToolExecutor = (
  toolName: string,
  args: Record<string, unknown>,
  message: UserMessage,
  ctx: AgentContext,
) => Promise<CodeSessionToolResult>;

export type CodeSessionManagedSandboxGetter = (
  sessionId: string,
  ownerUserId?: string,
) => Promise<{
  defaultTargetId?: string | null;
  targets?: RemoteExecutionTargetDescriptor[];
  targetDiagnostics?: RemoteExecutionTargetDiagnostic[];
  sandboxes: CodeSessionManagedSandbox[];
}>;

export type CodingTaskResumer = (
  message: UserMessage,
  ctx: AgentContext,
  userKey: string,
  decision?: IntentGatewayDecision,
  codeContext?: { sessionId?: string; workspaceRoot: string },
) => Promise<CodeSessionResponse | null>;

export type OnMessageFn = (
  message: UserMessage,
  ctx: AgentContext,
) => Promise<AgentResponse>;

export interface EnsureExplicitCodingTaskWorkspaceTargetInput {
  toolsEnabled: boolean;
  codeSessionStore?: Pick<CodeSessionStore, 'getSession' | 'listSessionsForUser'> | null;
  executeDirectCodeSessionTool: CodeSessionToolExecutor;
  message: UserMessage;
  ctx: AgentContext;
  decision?: IntentGatewayDecision;
  currentSession?: CodeSessionRecord | null;
  codeContext?: { workspaceRoot: string; sessionId?: string };
}

export type EnsureExplicitCodingTaskWorkspaceTargetResult =
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

export interface CodeSessionControlDeps {
  executeDirectCodeSessionTool: CodeSessionToolExecutor;
  getCodeSessionManagedSandboxes?: CodeSessionManagedSandboxGetter;
  getActivePendingAction: (
    userId: string,
    channel: string,
    surfaceId?: string,
  ) => PendingActionRecord | null;
  completePendingAction: (actionId: string) => void;
  resumeCodingTask: CodingTaskResumer;
  onMessage: OnMessageFn;
}

export interface CodeSessionControlGatewayInput extends CodeSessionControlDeps {
  toolsEnabled: boolean;
  message: UserMessage;
  ctx: AgentContext;
  decision?: IntentGatewayDecision;
}

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
  const current = await loadCurrentCodeSession(input);
  if (!current.success) {
    return { content: current.failure };
  }
  const session = current.session;
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

async function handleCodeSessionManagedSandboxes(input: {
  executeDirectCodeSessionTool: CodeSessionToolExecutor;
  getCodeSessionManagedSandboxes?: CodeSessionManagedSandboxGetter;
  decision?: IntentGatewayDecision;
  message: UserMessage;
  ctx: AgentContext;
}): Promise<CodeSessionResponse> {
  const current = await loadCurrentCodeSession(input);
  if (!current.success) {
    return { content: current.failure };
  }
  const session = current.session;
  if (!session) {
    return { content: 'This chat is not currently attached to any coding workspace.' };
  }

  const sessionId = toString(session.id).trim();
  const ownerUserId = toString(session.ownerUserId).trim() || input.message.userId?.trim();
  let sandboxes = extractManagedSandboxesFromSession(session);
  let targets: RemoteExecutionTargetDescriptor[] = [];
  let targetDiagnostics: RemoteExecutionTargetDiagnostic[] = [];
  let defaultTargetId = '';

  if (sessionId && input.getCodeSessionManagedSandboxes) {
    try {
      const refreshed = await input.getCodeSessionManagedSandboxes(sessionId, ownerUserId || undefined);
      if (Array.isArray(refreshed.sandboxes)) {
        sandboxes = refreshed.sandboxes;
      }
      if (Array.isArray(refreshed.targets)) {
        targets = refreshed.targets;
      }
      if (Array.isArray(refreshed.targetDiagnostics)) {
        targetDiagnostics = refreshed.targetDiagnostics;
      }
      defaultTargetId = toString(refreshed.defaultTargetId);
    } catch {
      // Fall back to the current session snapshot when the live refresh fails.
    }
  }

  const requestedProvider = input.decision?.entities.codeSessionSandboxProvider;
  const providerFilter = requestedProvider && requestedProvider !== 'all' ? requestedProvider : undefined;
  if (providerFilter) {
    const targetIdsBeforeFiltering = new Set(targets.map((target) => toString(target.id)).filter(Boolean));
    sandboxes = sandboxes.filter((sandbox) => managedSandboxMatchesProvider(sandbox, providerFilter));
    targets = targets.filter((target) => remoteSandboxTargetMatchesProvider(target, providerFilter));
    const filteredTargetIds = new Set(targets.map((target) => toString(target.id)).filter(Boolean));
    targetDiagnostics = targetDiagnostics.filter((diagnostic) => remoteSandboxDiagnosticMatchesProvider({
      diagnostic,
      provider: providerFilter,
      targetIdsBeforeFiltering,
      filteredTargetIds,
    }));
  }

  const providerLabel = providerFilter ? ` (${providerFilter})` : '';
  const lines = [
    'This chat is currently attached to:',
    formatDirectCodeSessionLine(session, true),
  ];
  if (sandboxes.length === 0) {
    lines.push(`No managed sandboxes${providerLabel} are currently attached to this coding session.`);
  } else {
    lines.push(`Managed sandboxes${providerLabel} attached to this coding session:`);
    for (const sandbox of sandboxes) {
      lines.push(formatManagedSandboxLine(sandbox));
    }
  }
  if (targets.length === 0) {
    lines.push(`Remote sandbox targets${providerLabel}: none configured for this session.`);
  } else {
    lines.push(`Remote sandbox targets${providerLabel}:`);
    for (const target of targets) {
      lines.push(formatRemoteSandboxTargetLine(target, defaultTargetId));
    }
  }
  if (targetDiagnostics.length > 0) {
    lines.push(`Remote sandbox diagnostics${providerLabel}:`);
    for (const diagnostic of targetDiagnostics) {
      lines.push(formatRemoteSandboxDiagnosticLine(diagnostic));
    }
  }
  return {
    content: lines.join('\n'),
    metadata: sessionId
      ? {
          codeSessionResolved: true,
          codeSessionId: sessionId,
        }
      : undefined,
  };
}

function managedSandboxMatchesProvider(
  sandbox: CodeSessionManagedSandbox,
  provider: NonNullable<IntentGatewayDecision['entities']['codeSessionSandboxProvider']>,
): boolean {
  return sandbox.backendKind === `${provider}_sandbox`;
}

function remoteSandboxTargetMatchesProvider(
  target: RemoteExecutionTargetDescriptor,
  provider: NonNullable<IntentGatewayDecision['entities']['codeSessionSandboxProvider']>,
): boolean {
  return target.providerFamily === provider || target.backendKind === `${provider}_sandbox`;
}

function remoteSandboxDiagnosticMatchesProvider(input: {
  diagnostic: RemoteExecutionTargetDiagnostic;
  provider: NonNullable<IntentGatewayDecision['entities']['codeSessionSandboxProvider']>;
  targetIdsBeforeFiltering: Set<string>;
  filteredTargetIds: Set<string>;
}): boolean {
  const targetId = toString(input.diagnostic.targetId);
  if (targetId) {
    if (input.filteredTargetIds.has(targetId)) return true;
    if (input.targetIdsBeforeFiltering.has(targetId)) return false;
    return targetId.toLowerCase().includes(input.provider);
  }
  return toString(input.diagnostic.profileName).toLowerCase().includes(input.provider);
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

export async function tryDirectCodeSessionControlFromGateway(
  input: CodeSessionControlGatewayInput,
): Promise<CodeSessionResponse | null> {
  if (!input.toolsEnabled) return null;
  if (!input.decision || (input.decision.route !== 'coding_session_control' && !isManagedSandboxStatusDecision(input.decision))) {
    return null;
  }

  let operation = input.decision.operation;
  const resource = input.decision.entities.codeSessionResource;
  if (isManagedSandboxStatusDecision(input.decision)) {
    return handleCodeSessionManagedSandboxes(input);
  }

  if (!operation || operation === 'unknown') {
    const text = input.message.content.toLowerCase();
    if (/\b(?:switch|attach|use|change to|connect)\b/.test(text)) {
      operation = 'update';
    } else if (/\b(?:detach|disconnect|leave)\b/.test(text)) {
      operation = 'delete';
    } else if (/\b(?:create|new|start)\b/.test(text)) {
      operation = 'create';
    } else if (/\b(?:current|active|what)\b/.test(text)) {
      operation = 'inspect';
    }
  }

  if (resource === 'session_list' || operation === 'navigate' || operation === 'search' || operation === 'read') {
    return handleCodeSessionList(input);
  }
  if (operation === 'inspect') {
    if (resource === 'managed_sandboxes') {
      return handleCodeSessionManagedSandboxes(input);
    }
    return handleCodeSessionCurrent(input);
  }
  if (operation === 'delete') {
    return handleCodeSessionDetach(input);
  }
  if (operation === 'update') {
    let target = input.decision.entities.sessionTarget || input.decision.entities.query || '';
    if (!target.trim()) {
      const match = input.message.content.match(/\b(?:switch|attach|change to|connect)\s+(?:to\s+)?(?:the\s+)?(.*)/i);
      if (match?.[1]) {
        target = match[1].trim();
      }
    }
    if (!target.trim()) {
      return { content: 'Please specify which coding session or workspace to switch to.' };
    }
    return handleCodeSessionAttach({
      ...input,
      target,
    });
  }
  if (operation === 'create') {
    let target = input.decision.entities.sessionTarget || input.decision.entities.path || input.decision.entities.query || '';
    if (!target.trim()) {
      const match = input.message.content.match(/\b(?:create|new|start)\s+(?:coding\s+)?(?:workspace|session)\s+(?:for|in|at)\s+(.*)/i);
      if (match?.[1]) {
        target = match[1].trim();
      }
    }
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

function isManagedSandboxStatusDecision(decision: IntentGatewayDecision): boolean {
  if (decision.route === 'coding_session_control' && decision.entities.codeSessionResource === 'managed_sandboxes') {
    return true;
  }
  return Array.isArray(decision.plannedSteps)
    && decision.plannedSteps.some((step) => Array.isArray(step.expectedToolCategories)
      && step.expectedToolCategories.some((category) => {
        const normalized = category.trim();
        return normalized === 'daytona_status'
          || normalized === 'managed_sandbox_status'
          || normalized === 'remote_sandbox_status';
      }));
}

async function loadCurrentCodeSession(input: {
  executeDirectCodeSessionTool: CodeSessionToolExecutor;
  message: UserMessage;
  ctx: AgentContext;
}): Promise<{ success: true; session: Record<string, unknown> | null } | { success: false; failure: string }> {
  const result = await input.executeDirectCodeSessionTool('code_session_current', {}, input.message, input.ctx);
  if (!toBoolean(result.success)) {
    return {
      success: false,
      failure: toString(result.message) || 'I could not inspect the current coding workspace.',
    };
  }
  return {
    success: true,
    session: isRecord(result.output) && isRecord(result.output.session) ? result.output.session : null,
  };
}

function extractManagedSandboxesFromSession(session: Record<string, unknown>): CodeSessionManagedSandbox[] {
  const workState = isRecord(session.workState) ? session.workState : null;
  const managedSandboxes = Array.isArray(workState?.managedSandboxes)
    ? workState.managedSandboxes.filter((value): value is CodeSessionManagedSandbox => isRecord(value))
    : [];
  return managedSandboxes;
}

function formatManagedSandboxLine(sandbox: CodeSessionManagedSandbox): string {
  const formatValue = (value: string | number | boolean | undefined | null): string => {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text || '(none)';
  };
  const lifecycleState = formatValue(sandbox.state || sandbox.status);
  const canRestart = sandbox.backendKind === 'daytona_sandbox' && lifecycleState.toLowerCase() === 'stopped';
  return `- ${formatValue(sandbox.profileName)} | backend=${sandbox.backendKind} | state=${lifecycleState} | status=${formatValue(sandbox.status)} | sandboxId=${formatValue(sandbox.sandboxId)} | workspace=${formatValue(sandbox.remoteWorkspaceRoot || sandbox.localWorkspaceRoot)} | canRestart=${canRestart ? 'yes' : 'no'}${sandbox.healthReason ? ` | note=${formatValue(sandbox.healthReason)}` : ''}`;
}

function formatRemoteSandboxTargetLine(target: RemoteExecutionTargetDescriptor, defaultTargetId: string): string {
  const formatValue = (value: string | number | boolean | undefined | null): string => {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text || '(none)';
  };
  const isDefault = defaultTargetId && target.id === defaultTargetId;
  const healthState = target.healthState || 'unknown';
  const reachable = target.capabilityState !== 'ready'
    ? 'no'
    : healthState === 'healthy'
      ? 'yes'
      : healthState === 'unreachable'
        ? 'no'
        : 'unknown';
  return `- ${formatValue(target.profileName || target.profileId)} | provider=${target.providerFamily} | backend=${target.backendKind} | capability=${target.capabilityState} | health=${formatValue(healthState)} | reachable=${reachable} | default=${isDefault ? 'yes' : 'no'} | profile=${formatValue(target.profileId)}${target.healthCause ? ` | likelyCause=${formatValue(target.healthCause)}` : ''}${target.healthReason ? ` | note=${formatValue(target.healthReason)}` : ` | note=${formatValue(target.reason)}`}`;
}

function formatRemoteSandboxDiagnosticLine(diagnostic: RemoteExecutionTargetDiagnostic): string {
  const formatValue = (value: string | number | boolean | undefined | null): string => {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text || '(none)';
  };
  return `- severity=${formatValue(diagnostic.severity)} | code=${formatValue(diagnostic.code)}${diagnostic.targetId ? ` | target=${formatValue(diagnostic.targetId)}` : ''}${diagnostic.profileName ? ` | profile=${formatValue(diagnostic.profileName)}` : ''}${diagnostic.likelyCause ? ` | likelyCause=${formatValue(diagnostic.likelyCause)}` : ''}${diagnostic.nextAction ? ` | nextAction=${formatValue(diagnostic.nextAction)}` : ''} | message=${formatValue(diagnostic.message)}`;
}
