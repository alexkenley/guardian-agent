import type { AgentContext, UserMessage } from '../../agent/types.js';
import {
  isAffirmativeContinuation,
  normalizeScheduledEmailBody,
  toBoolean,
  toString,
} from '../../chat-agent-helpers.js';
import type { ToolExecutor } from '../../tools/executor.js';
import type { ConversationService } from '../conversation.js';
import {
  parseScheduledEmailAutomationIntent,
  parseScheduledEmailScheduleIntent,
} from '../email-automation-intent.js';
import { buildGmailRawMessage, parseDirectGmailWriteIntent } from '../gmail-compose.js';
import { buildPendingApprovalMetadata } from '../pending-approval-copy.js';
import type {
  PendingActionApprovalSummary,
  PendingActionRecord,
} from '../pending-actions.js';
import { readToolMessageSecurityContext } from './message-security-context.js';

type ScheduledEmailAutomationResponse =
  | string
  | { content: string; metadata?: Record<string, unknown> }
  | null;

type ScheduledEmailAutomationDetail = {
  to?: string;
  subject?: string;
  body?: string;
};

type ScheduledEmailAutomationSchedule = {
  to: string;
  cron: string;
  runOnce: boolean;
};

export interface DirectScheduledEmailAutomationDeps {
  agentId: string;
  tools?: Pick<ToolExecutor, 'isEnabled' | 'executeModelTool' | 'getApprovalSummaries'> | null;
  conversationService?: Pick<ConversationService, 'getHistoryForContext'> | null;
  setApprovalFollowUp: (
    approvalId: string,
    copy: { approved: string; denied: string },
  ) => void;
  getPendingApprovals: (
    userKey: string,
    surfaceId?: string,
    nowMs?: number,
  ) => { ids: string[] } | null;
  formatPendingApprovalPrompt: (
    ids: string[],
    summaries?: Map<string, { toolName: string; argsPreview: string }>,
  ) => string;
  setPendingApprovalActionForRequest: (
    userKey: string,
    surfaceId: string | undefined,
    input: {
      prompt: string;
      approvalIds: string[];
      approvalSummaries?: PendingActionApprovalSummary[];
      originalUserContent: string;
      route?: string;
      operation?: string;
      summary?: string;
      turnRelation?: string;
      resolution?: string;
      missingFields?: string[];
      provenance?: PendingActionRecord['intent']['provenance'];
      entities?: Record<string, unknown>;
      codeSessionId?: string;
      resume?: PendingActionRecord['resume'];
    },
  ) => { action: PendingActionRecord | null; collisionPrompt?: string };
  buildPendingApprovalBlockedResponse: (
    result: { action: PendingActionRecord | null; collisionPrompt?: string },
    fallbackContent: string,
  ) => { content: string; metadata?: Record<string, unknown> };
}

export async function tryDirectScheduledEmailAutomation(
  input: {
    message: UserMessage;
    ctx: AgentContext;
    userKey: string;
    stateAgentId: string;
  },
  deps: DirectScheduledEmailAutomationDeps,
): Promise<ScheduledEmailAutomationResponse> {
  if (!deps.tools?.isEnabled() || !deps.conversationService) return null;

  const directScheduledIntent = parseScheduledEmailAutomationIntent(input.message.content);
  const directScheduleOnlyIntent = parseScheduledEmailScheduleIntent(input.message.content);
  const directDetailIntent = parseDirectGmailWriteIntent(input.message.content);
  if (directScheduledIntent && directDetailIntent && directDetailIntent.subject && directDetailIntent.body) {
    return createDirectScheduledEmailAutomation({
      schedule: directScheduledIntent,
      detail: directDetailIntent,
      message: input.message,
      ctx: input.ctx,
      userKey: input.userKey,
    }, deps);
  }

  const history = deps.conversationService.getHistoryForContext({
    agentId: input.stateAgentId,
    userId: input.message.userId,
    channel: input.message.channel,
  });
  if (history.length === 0) return null;

  const recentHistory = [...history].reverse();
  const priorDetailedContext = recentHistory.find((entry) => {
    const detail = parseDirectGmailWriteIntent(entry.content);
    return Boolean(detail?.subject && detail.body);
  });
  const priorScheduleContext = recentHistory.find((entry) => (
    parseScheduledEmailAutomationIntent(entry.content)
    || parseScheduledEmailScheduleIntent(entry.content)
  ));
  const detailIntent = (directDetailIntent && (directDetailIntent.subject || directDetailIntent.body || directDetailIntent.to))
    ? directDetailIntent
    : priorDetailedContext
      ? parseDirectGmailWriteIntent(priorDetailedContext.content)
      : null;
  const scheduledIntent = directScheduledIntent
    ?? (directScheduleOnlyIntent && detailIntent?.to
      ? { to: detailIntent.to, ...directScheduleOnlyIntent }
      : null)
    ?? (priorScheduleContext
      ? parseScheduledEmailAutomationIntent(priorScheduleContext.content)
        ?? (detailIntent?.to
          ? { to: detailIntent.to, ...parseScheduledEmailScheduleIntent(priorScheduleContext.content)! }
          : null)
      : null);
  const shouldTreatAsFollowUp = Boolean(
    directScheduleOnlyIntent
    || (directDetailIntent && (directDetailIntent.subject || directDetailIntent.body))
    || isAffirmativeContinuation(input.message.content),
  );
  if (!shouldTreatAsFollowUp) return null;
  if (!scheduledIntent || !detailIntent) return null;

  const subject = detailIntent.subject?.trim();
  const body = detailIntent.body?.trim();
  if (!subject || !body) {
    return 'To schedule that email automation, I still need both the subject and the body text.';
  }

  const to = detailIntent.to?.trim() || scheduledIntent.to;
  if (!to) {
    return 'To schedule that email automation, I still need the recipient email address.';
  }

  return createDirectScheduledEmailAutomation({
    schedule: { ...scheduledIntent, to },
    detail: { ...detailIntent, to, subject, body },
    message: input.message,
    ctx: input.ctx,
    userKey: input.userKey,
  }, deps);
}

async function createDirectScheduledEmailAutomation(
  input: {
    schedule: ScheduledEmailAutomationSchedule;
    detail: ScheduledEmailAutomationDetail;
    message: UserMessage;
    ctx: AgentContext;
    userKey: string;
  },
  deps: DirectScheduledEmailAutomationDeps,
): Promise<Exclude<ScheduledEmailAutomationResponse, null>> {
  const to = input.detail.to?.trim() || input.schedule.to;
  const subject = input.detail.subject?.trim() || '';
  const body = normalizeScheduledEmailBody(input.detail.body, subject);
  const raw = buildGmailRawMessage({ to, subject, body });
  const taskName = input.schedule.runOnce
    ? `Scheduled Email to ${to}`
    : `Recurring Email to ${to}`;
  const toolRequest = {
    origin: 'assistant' as const,
    agentId: deps.agentId,
    userId: input.message.userId,
    surfaceId: input.message.surfaceId,
    principalId: input.message.principalId ?? input.message.userId,
    principalRole: input.message.principalRole,
    channel: input.message.channel,
    requestId: input.message.id,
    agentContext: { checkAction: input.ctx.checkAction },
    ...readToolMessageSecurityContext(input.message),
  };

  const toolResult = await deps.tools!.executeModelTool(
    'automation_save',
    {
      id: taskName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'scheduled-email-automation',
      name: taskName,
      enabled: true,
      kind: 'standalone_task',
      task: {
        target: 'gws',
        args: {
          service: 'gmail',
          resource: 'users messages',
          method: 'send',
          params: { userId: 'me' },
          json: { raw },
        },
      },
      schedule: {
        enabled: true,
        cron: input.schedule.cron,
        runOnce: input.schedule.runOnce,
      },
    },
    toolRequest,
  );

  if (!toBoolean(toolResult.success)) {
    const status = toString(toolResult.status);
    if (status === 'pending_approval') {
      const approvalId = toString(toolResult.approvalId);
      const existingIds = deps.getPendingApprovals(input.userKey)?.ids ?? [];
      const pendingIds = approvalId ? [...new Set([...existingIds, approvalId])] : existingIds;
      if (approvalId) {
        deps.setApprovalFollowUp(approvalId, {
          approved: input.schedule.runOnce
            ? `I created the one-shot email automation to ${to}.`
            : `I created the recurring email automation to ${to}.`,
          denied: 'I did not create the scheduled email automation.',
        });
      }
      const summaries = pendingIds.length > 0 ? deps.tools?.getApprovalSummaries(pendingIds) : undefined;
      const prompt = deps.formatPendingApprovalPrompt(pendingIds, summaries);
      const pendingActionResult = deps.setPendingApprovalActionForRequest(
        input.userKey,
        input.message.surfaceId,
        {
          prompt,
          approvalIds: pendingIds,
          approvalSummaries: buildPendingApprovalMetadata(pendingIds, summaries),
          originalUserContent: input.message.content,
          route: 'automation_authoring',
          operation: 'schedule',
          summary: input.schedule.runOnce
            ? 'Creates a one-shot scheduled email automation.'
            : 'Creates a recurring scheduled email automation.',
          turnRelation: 'new_request',
          resolution: 'ready',
        },
      );
      return deps.buildPendingApprovalBlockedResponse(pendingActionResult, [
        `I prepared a ${input.schedule.runOnce ? 'one-shot' : 'recurring'} email automation to ${to}.`,
        prompt,
      ].filter(Boolean).join('\n\n'));
    }
    const msg = toString(toolResult.message) || toString(toolResult.error) || 'Scheduled email automation creation failed.';
    return `I tried to create the scheduled email automation, but it failed: ${msg}`;
  }

  return input.schedule.runOnce
    ? `I created a one-shot email automation to ${to}. It will run on the next scheduled time.`
    : `I created a recurring email automation to ${to}.`;
}
