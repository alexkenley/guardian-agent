import type { AgentContext, UserMessage } from '../../agent/types.js';
import { isRecord, toBoolean, toString } from '../../chat-agent-helpers.js';
import type { ToolExecutor } from '../../tools/executor.js';
import type { IntentGatewayDecision } from '../intent-gateway.js';
import {
  buildPendingApprovalMetadata,
  formatPendingApprovalMessage,
} from '../pending-approval-copy.js';
import type { PendingActionRecord } from '../pending-actions.js';
import type { PendingActionSetResult } from './orchestration-state.js';

export type DirectSecondBrainMutationItemType = 'note' | 'task' | 'calendar' | 'person' | 'library' | 'brief' | 'routine';
export type DirectSecondBrainMutationAction = 'create' | 'update' | 'delete' | 'complete';
export type DirectSecondBrainMutationToolName =
  | 'second_brain_note_upsert'
  | 'second_brain_note_delete'
  | 'second_brain_task_upsert'
  | 'second_brain_task_delete'
  | 'second_brain_calendar_upsert'
  | 'second_brain_calendar_delete'
  | 'second_brain_person_upsert'
  | 'second_brain_person_delete'
  | 'second_brain_library_upsert'
  | 'second_brain_library_delete'
  | 'second_brain_brief_upsert'
  | 'second_brain_generate_brief'
  | 'second_brain_brief_update'
  | 'second_brain_brief_delete'
  | 'second_brain_routine_create'
  | 'second_brain_routine_update'
  | 'second_brain_routine_delete';

export interface DirectSecondBrainSuccessDescriptor {
  itemType: DirectSecondBrainMutationItemType;
  action: DirectSecondBrainMutationAction;
  fallbackId?: string;
  fallbackLabel?: string;
}

export const SECOND_BRAIN_MUTATION_APPROVAL_DESCRIPTOR_ENTITY = 'secondBrainMutationApproval';

export function buildSecondBrainMutationApprovalEntities(
  entities: Record<string, unknown> | IntentGatewayDecision['entities'],
  descriptor: DirectSecondBrainSuccessDescriptor,
): Record<string, unknown> {
  return {
    ...entities,
    [SECOND_BRAIN_MUTATION_APPROVAL_DESCRIPTOR_ENTITY]: {
      itemType: descriptor.itemType,
      action: descriptor.action,
      ...(toString(descriptor.fallbackId).trim()
        ? { fallbackId: toString(descriptor.fallbackId).trim() }
        : {}),
      ...(toString(descriptor.fallbackLabel).trim()
        ? { fallbackLabel: toString(descriptor.fallbackLabel).trim() }
        : {}),
    },
  };
}

export function readSecondBrainMutationApprovalDescriptor(
  entities: Record<string, unknown> | undefined,
): DirectSecondBrainSuccessDescriptor | null {
  const raw = entities?.[SECOND_BRAIN_MUTATION_APPROVAL_DESCRIPTOR_ENTITY];
  if (!isRecord(raw)) return null;
  const itemType = toString(raw.itemType).trim();
  const action = toString(raw.action).trim();
  if (!isSecondBrainMutationItemType(itemType) || !isSecondBrainMutationAction(action)) {
    return null;
  }
  return {
    itemType,
    action,
    ...(toString(raw.fallbackId).trim() ? { fallbackId: toString(raw.fallbackId).trim() } : {}),
    ...(toString(raw.fallbackLabel).trim() ? { fallbackLabel: toString(raw.fallbackLabel).trim() } : {}),
  };
}

function isSecondBrainMutationItemType(value: string): value is DirectSecondBrainMutationItemType {
  return value === 'note'
    || value === 'task'
    || value === 'calendar'
    || value === 'person'
    || value === 'library'
    || value === 'brief'
    || value === 'routine';
}

function isSecondBrainMutationAction(value: string): value is DirectSecondBrainMutationAction {
  return value === 'create'
    || value === 'update'
    || value === 'delete'
    || value === 'complete';
}

function defaultSecondBrainItemLabel(itemType: DirectSecondBrainMutationItemType): string {
  switch (itemType) {
    case 'note':
      return 'Untitled note';
    case 'task':
      return 'Untitled task';
    case 'calendar':
      return 'Untitled event';
    case 'person':
      return 'Untitled person';
    case 'library':
      return 'Untitled library item';
    case 'brief':
      return 'Untitled brief';
    case 'routine':
      return 'Untitled routine';
    default:
      return 'Untitled item';
  }
}

function resolveDirectSecondBrainMutationLabel(
  itemType: DirectSecondBrainMutationItemType,
  record: Record<string, unknown> | null,
  fallbackLabel?: string,
): string {
  const resolvedFallback = toString(fallbackLabel).trim();
  switch (itemType) {
    case 'person':
      return toString(record?.name).trim()
        || toString(record?.title).trim()
        || resolvedFallback
        || defaultSecondBrainItemLabel(itemType);
    case 'library':
      return toString(record?.title).trim()
        || toString(record?.url).trim()
        || resolvedFallback
        || defaultSecondBrainItemLabel(itemType);
    default:
      return toString(record?.title).trim()
        || toString(record?.name).trim()
        || resolvedFallback
        || defaultSecondBrainItemLabel(itemType);
  }
}

function secondBrainMutationVerb(
  descriptor: DirectSecondBrainSuccessDescriptor,
): { singularLabel: string; actionLabel: string } {
  switch (`${descriptor.itemType}:${descriptor.action}`) {
    case 'note:create':
      return { singularLabel: 'Note', actionLabel: 'created' };
    case 'note:update':
      return { singularLabel: 'Note', actionLabel: 'updated' };
    case 'note:delete':
      return { singularLabel: 'Note', actionLabel: 'deleted' };
    case 'task:create':
      return { singularLabel: 'Task', actionLabel: 'created' };
    case 'task:update':
      return { singularLabel: 'Task', actionLabel: 'updated' };
    case 'task:complete':
      return { singularLabel: 'Task', actionLabel: 'completed' };
    case 'task:delete':
      return { singularLabel: 'Task', actionLabel: 'deleted' };
    case 'calendar:create':
      return { singularLabel: 'Calendar event', actionLabel: 'created' };
    case 'calendar:update':
      return { singularLabel: 'Calendar event', actionLabel: 'updated' };
    case 'calendar:delete':
      return { singularLabel: 'Calendar event', actionLabel: 'deleted' };
    case 'person:create':
      return { singularLabel: 'Contact', actionLabel: 'created' };
    case 'person:update':
      return { singularLabel: 'Contact', actionLabel: 'updated' };
    case 'person:delete':
      return { singularLabel: 'Contact', actionLabel: 'deleted' };
    case 'library:create':
      return { singularLabel: 'Library item', actionLabel: 'created' };
    case 'library:update':
      return { singularLabel: 'Library item', actionLabel: 'updated' };
    case 'library:delete':
      return { singularLabel: 'Library item', actionLabel: 'deleted' };
    case 'brief:create':
      return { singularLabel: 'Brief', actionLabel: 'created' };
    case 'brief:update':
      return { singularLabel: 'Brief', actionLabel: 'updated' };
    case 'brief:delete':
      return { singularLabel: 'Brief', actionLabel: 'deleted' };
    case 'routine:create':
      return { singularLabel: 'Routine', actionLabel: 'created' };
    case 'routine:update':
      return { singularLabel: 'Routine', actionLabel: 'updated' };
    case 'routine:delete':
      return { singularLabel: 'Routine', actionLabel: 'deleted' };
    default:
      return { singularLabel: 'Item', actionLabel: 'updated' };
  }
}

export function buildDirectSecondBrainMutationSuccessResponse<TFocusState>(input: {
  descriptor: DirectSecondBrainSuccessDescriptor;
  output: unknown;
  focusState: TFocusState;
  buildFocusMetadata: (
    focusState: TFocusState,
    itemType: DirectSecondBrainMutationItemType,
    items: Array<{ id: string; label?: string }>,
    options?: { preferredFocusId?: string },
  ) => Record<string, unknown> | undefined;
  buildFocusRemovalMetadata: (
    focusState: TFocusState,
    itemType: DirectSecondBrainMutationItemType,
  ) => Record<string, unknown> | undefined;
}): { content: string; metadata?: Record<string, unknown> } {
  const record = isRecord(input.output) ? input.output : null;
  const id = toString(record?.id).trim() || toString(input.descriptor.fallbackId).trim();
  const label = resolveDirectSecondBrainMutationLabel(
    input.descriptor.itemType,
    record,
    input.descriptor.fallbackLabel,
  );
  const { singularLabel, actionLabel } = secondBrainMutationVerb(input.descriptor);
  const metadata = input.descriptor.action === 'delete'
    ? input.buildFocusRemovalMetadata(input.focusState, input.descriptor.itemType)
    : id
      ? input.buildFocusMetadata(
        input.focusState,
        input.descriptor.itemType,
        [{ id, label }],
        { preferredFocusId: id },
      )
      : undefined;
  return {
    content: `${singularLabel} ${actionLabel}: ${label}`,
    ...(metadata ? { metadata } : {}),
  };
}

export function buildDirectSecondBrainClarificationResponse(input: {
  message: UserMessage;
  decision: IntentGatewayDecision;
  prompt: string;
  field?: string;
  missingFields?: string[];
  entities?: Record<string, unknown>;
  toPendingActionEntities: (entities: unknown) => Record<string, unknown> | undefined;
  setClarificationPendingAction: (
    userId: string,
    channel: string,
    surfaceId: string | undefined,
    action: {
      blockerKind: PendingActionRecord['blocker']['kind'];
      field?: string;
      prompt: string;
      originalUserContent: string;
      route?: string;
      operation?: string;
      summary?: string;
      turnRelation?: string;
      resolution?: string;
      missingFields?: string[];
      provenance?: PendingActionRecord['intent']['provenance'];
      entities?: Record<string, unknown>;
    },
    nowMs?: number,
  ) => PendingActionSetResult;
  buildImmediateResponseMetadata: (
    pendingApprovalIds: string[],
    userId: string,
    channel: string,
    surfaceId?: string,
    options?: { includePendingAction?: boolean },
  ) => Record<string, unknown> | undefined;
}): { content: string; metadata?: Record<string, unknown> } {
  const pendingActionResult = input.setClarificationPendingAction(
    input.message.userId,
    input.message.channel,
    input.message.surfaceId,
    {
      blockerKind: 'clarification',
      ...(input.field ? { field: input.field } : {}),
      prompt: input.prompt,
      originalUserContent: input.message.content,
      route: input.decision.route,
      operation: input.decision.operation,
      summary: input.decision.summary,
      turnRelation: input.decision.turnRelation,
      resolution: 'needs_clarification',
      missingFields: input.missingFields ?? [],
      provenance: input.decision.provenance,
      entities: input.toPendingActionEntities({
        ...input.decision.entities,
        ...(input.entities ?? {}),
      }),
    },
  );
  return {
    content: pendingActionResult.collisionPrompt ?? input.prompt,
    metadata: input.buildImmediateResponseMetadata(
      [],
      input.message.userId,
      input.message.channel,
      input.message.surfaceId,
      { includePendingAction: true },
    ),
  };
}

export async function executeDirectSecondBrainMutation<TFocusState>(input: {
  message: UserMessage;
  ctx: AgentContext;
  userKey: string;
  decision: IntentGatewayDecision;
  toolName: DirectSecondBrainMutationToolName;
  args: Record<string, unknown>;
  summary: string;
  pendingIntro: string;
  successDescriptor: DirectSecondBrainSuccessDescriptor;
  focusState: TFocusState;
  agentId: string;
  tools?: Pick<ToolExecutor, 'executeModelTool' | 'getApprovalSummaries' | 'isEnabled'> | null;
  getPendingApprovals: (
    userKey: string,
    surfaceId?: string,
    nowMs?: number,
  ) => { ids: string[]; createdAt: number; expiresAt: number } | null;
  setApprovalFollowUp: (
    approvalId: string,
    copy: { approved?: string; denied?: string },
  ) => void;
  formatPendingApprovalPrompt: (
    ids: string[],
    summaries?: Map<string, { toolName: string; argsPreview: string; actionLabel?: string }>,
  ) => string;
  setPendingApprovalActionForRequest: (
    userKey: string,
    surfaceId: string | undefined,
    action: {
      prompt: string;
      approvalIds: string[];
      approvalSummaries?: PendingActionRecord['blocker']['approvalSummaries'];
      originalUserContent: string;
      route?: string;
      operation?: string;
      summary?: string;
      turnRelation?: string;
      resolution?: string;
      missingFields?: string[];
      provenance?: PendingActionRecord['intent']['provenance'];
      entities?: Record<string, unknown>;
      resume?: PendingActionRecord['resume'];
      codeSessionId?: string;
    },
    nowMs?: number,
  ) => PendingActionSetResult;
  buildPendingApprovalBlockedResponse: (
    result: PendingActionSetResult,
    fallbackContent: string,
  ) => { content: string; metadata?: Record<string, unknown> };
  toPendingActionEntities: (entities: unknown) => Record<string, unknown> | undefined;
  buildDirectSecondBrainMutationSuccessResponse: (
    descriptor: DirectSecondBrainSuccessDescriptor,
    output: unknown,
    focusState: TFocusState,
  ) => { content: string; metadata?: Record<string, unknown> };
}): Promise<string | { content: string; metadata?: Record<string, unknown> }> {
  if (!input.tools?.isEnabled()) {
    return 'Second Brain tools are unavailable right now.';
  }

  const toolResult = await input.tools.executeModelTool(
    input.toolName,
    input.args,
    {
      origin: 'assistant',
      agentId: input.agentId,
      userId: input.message.userId,
      channel: input.message.channel,
      requestId: input.message.id,
      agentContext: { checkAction: input.ctx.checkAction },
    },
  );

  if (toBoolean(toolResult.success)) {
    return input.buildDirectSecondBrainMutationSuccessResponse(
      input.successDescriptor,
      toolResult.output,
      input.focusState,
    );
  }

  const status = toString(toolResult.status);
  if (status === 'pending_approval') {
    const approvalId = toString(toolResult.approvalId);
    const existingIds = input.getPendingApprovals(input.userKey, input.message.surfaceId)?.ids ?? [];
    const pendingIds = approvalId ? [...new Set([...existingIds, approvalId])] : existingIds;
    if (approvalId) {
      input.setApprovalFollowUp(approvalId, {
        denied: 'I did not complete the local Second Brain update.',
      });
    }
    const summaries = pendingIds.length > 0 ? input.tools?.getApprovalSummaries(pendingIds) : undefined;
    const structuredPrompt = formatPendingApprovalMessage(
      pendingIds
        .map((id) => summaries?.get(id))
        .filter((summary): summary is { toolName: string; argsPreview: string; actionLabel?: string } => Boolean(summary)),
    );
    const pendingActionResult = input.setPendingApprovalActionForRequest(
      input.userKey,
      input.message.surfaceId,
      {
        prompt: structuredPrompt,
        approvalIds: pendingIds,
        approvalSummaries: buildPendingApprovalMetadata(pendingIds, summaries),
        originalUserContent: input.message.content,
        route: 'personal_assistant_task',
        operation: input.decision.operation,
        summary: input.summary,
        turnRelation: input.decision.turnRelation,
        resolution: input.decision.resolution,
        provenance: input.decision.provenance,
        entities: input.toPendingActionEntities(buildSecondBrainMutationApprovalEntities(
          input.decision.entities,
          input.successDescriptor,
        )),
      },
    );
    return input.buildPendingApprovalBlockedResponse(pendingActionResult, [
      input.pendingIntro,
      structuredPrompt,
    ].filter(Boolean).join('\n\n'));
  }

  const errorMessage = toString(toolResult.message) || toString(toolResult.error) || 'Second Brain update failed.';
  return `I couldn't complete the local Second Brain update: ${errorMessage}`;
}
