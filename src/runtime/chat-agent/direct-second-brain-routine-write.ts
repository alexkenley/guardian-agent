import type { AgentContext, UserMessage } from '../../agent/types.js';
import { isRecord, toString } from '../../chat-agent-helpers.js';
import type { IntentGatewayDecision } from '../intent-gateway.js';
import type { SecondBrainService } from '../second-brain/second-brain-service.js';
import type {
  DirectSecondBrainMutationItemType,
  DirectSecondBrainMutationToolName,
} from './direct-second-brain-mutation.js';

interface RoutineWriteFocusItem {
  id: string;
  label?: string;
}

interface RoutineWriteFocusEntry {
  focusId?: string;
  items: RoutineWriteFocusItem[];
}

type SecondBrainWriteResponse = string | { content: string; metadata?: Record<string, unknown> } | null;

interface DirectSecondBrainMutationExecutor<TFocusState> {
  (
    input: {
      message: UserMessage;
      ctx: AgentContext;
      userKey: string;
      decision: IntentGatewayDecision;
      toolName: DirectSecondBrainMutationToolName;
      args: Record<string, unknown>;
      summary: string;
      pendingIntro: string;
      successDescriptor: {
        itemType: DirectSecondBrainMutationItemType;
        action: 'create' | 'update' | 'delete' | 'complete';
        fallbackId?: string;
        fallbackLabel?: string;
      };
      focusState: TFocusState | null | undefined;
    }
  ): Promise<string | { content: string; metadata?: Record<string, unknown> }>;
}

export async function tryDirectSecondBrainRoutineWrite<TFocusState>(input: {
  secondBrainService: SecondBrainService & {
    listRoutineRecords?: () => Array<Record<string, unknown>>;
    getRoutineRecordById?: (id: string) => Record<string, unknown> | null;
  };
  message: UserMessage;
  ctx: AgentContext;
  userKey: string;
  decision: IntentGatewayDecision;
  focusState: TFocusState | null | undefined;
  getFocusEntry: (
    focusState: TFocusState | null | undefined,
    itemType: DirectSecondBrainMutationItemType,
  ) => RoutineWriteFocusEntry | null;
  buildFocusMetadata: (
    focusState: TFocusState | null | undefined,
    itemType: DirectSecondBrainMutationItemType,
    items: Array<{ id: string; label?: string }>,
    options?: { preferredFocusId?: string },
  ) => Record<string, unknown> | undefined;
  normalizeRoutineNameForMatch: (value: string) => string;
  normalizeRoutineTemplateIdForMatch: (value: string) => string;
  extractExplicitNamedTitle: (text: string) => string;
  extractRoutineDeliveryDefaults: (text: string) => Array<'web' | 'cli' | 'telegram'> | undefined;
  extractRoutineScheduleTiming: (text: string) => Record<string, unknown> | undefined;
  extractRoutineFocusQuery: (text: string) => string | undefined;
  extractCustomRoutineCreate: (
    text: string,
  ) => {
    templateId: 'topic-watch' | 'deadline-watch' | 'scheduled-review';
    config: Record<string, unknown>;
  } | null;
  extractQuotedPhrase: (text: string) => string | undefined;
  findMatchingRoutineForCreate: (
    routines: ReadonlyArray<{
      id?: string;
      templateId?: string;
      name?: string;
      timing?: unknown;
      trigger?: { mode?: string; eventType?: string; lookaheadMinutes?: unknown };
      delivery?: string[];
      focusQuery?: string;
      topicQuery?: string;
      dueWithinHours?: number;
      includeOverdue?: boolean;
    }>,
    createInput: {
      templateId: string;
      timing?: unknown;
      defaultTiming?: unknown;
      delivery?: readonly string[];
      defaultDelivery?: readonly string[];
      config?: unknown;
    },
  ) => { id?: string; name?: string } | null;
  routineTopicQuery: (routine: { topicQuery?: string; config?: { topicQuery?: string } }) => string;
  extractRoutineEnabledState: (text: string) => boolean | undefined;
  extractRoutingBias: (text: string) => 'local_first' | 'balanced' | 'quality_first' | undefined;
  extractRoutineLookaheadMinutes: (text: string) => number | undefined;
  extractRoutineTopicWatchQuery: (text: string) => string | undefined;
  extractRoutineDueWithinHours: (text: string) => number | undefined;
  extractRoutineIncludeOverdue: (text: string) => boolean | undefined;
  routineDeliveryChannels: (routine: { delivery?: string[]; deliveryDefaults?: string[] }) => string[];
  deriveRoutineTimingKind: (
    routine: {
      timing?: { kind?: string };
      trigger?: { mode?: string; eventType?: string };
    },
  ) => string | undefined;
  buildToolSafeRoutineTrigger: (
    trigger: Record<string, unknown> | undefined,
    fallbackTrigger?: Record<string, unknown> | null,
  ) => Record<string, unknown> | undefined;
  executeMutation: DirectSecondBrainMutationExecutor<TFocusState>;
}): Promise<SecondBrainWriteResponse> {
  const focused = input.focusState;
  const routineFocus = input.getFocusEntry(focused, 'routine');
  const focusItem = routineFocus
    ? routineFocus.items.find((item) => item.id === routineFocus.focusId) ?? null
    : null;
  const routineCatalog = input.secondBrainService.listRoutineCatalog();
  const configuredRoutines = input.secondBrainService.listRoutines();
  const configuredRoutineRecords = typeof input.secondBrainService.listRoutineRecords === 'function'
    ? input.secondBrainService.listRoutineRecords()
    : [];
  const normalizedContent = input.normalizeRoutineNameForMatch(input.message.content);
  const explicitRoutineTitle = input.extractExplicitNamedTitle(input.message.content);
  const matchedCatalogEntry = routineCatalog
    .filter((entry) => {
      const normalizedName = input.normalizeRoutineNameForMatch(entry.name);
      const normalizedTemplateId = input.normalizeRoutineTemplateIdForMatch(entry.templateId);
      if (!normalizedName && !normalizedTemplateId) {
        return false;
      }
      if (explicitRoutineTitle) {
        const normalizedExplicit = input.normalizeRoutineNameForMatch(explicitRoutineTitle);
        return normalizedExplicit === normalizedName || normalizedExplicit === normalizedTemplateId;
      }
      return normalizedContent.includes(normalizedName) || normalizedContent.includes(normalizedTemplateId);
    })
    .sort((left, right) => right.name.length - left.name.length)[0] ?? null;
  const matchedRoutineId = matchedCatalogEntry?.configuredRoutineId
    ?? matchedCatalogEntry?.templateId
    ?? focusItem?.id;

  switch (input.decision.operation) {
    case 'create': {
      const explicitDelivery = input.extractRoutineDeliveryDefaults(input.message.content);
      const explicitScheduleTiming = input.extractRoutineScheduleTiming(input.message.content);
      const explicitRoutineName = extractRoutineNameOverride(input.message.content);
      const explicitFocusQuery = suppressNameOnlyFocusQuery(
        input.extractRoutineFocusQuery(input.message.content),
        [explicitRoutineName],
      );
      const inferredRoutineCreate = input.extractCustomRoutineCreate(input.message.content);
      const createCatalogEntry = matchedCatalogEntry
        ?? (inferredRoutineCreate
          ? routineCatalog.find((entry) => entry.templateId === inferredRoutineCreate.templateId) ?? null
          : null);
      if (!createCatalogEntry) {
        return 'To create a Second Brain routine, tell me which routine to create, or say something like "create a scheduled review every Friday at 4 pm" or "message me when anything mentions Harbor launch."';
      }
      if (
        !createCatalogEntry.allowMultiple
        && createCatalogEntry.configured
        && createCatalogEntry.configuredRoutineId?.trim()
        && !(createCatalogEntry.supportsFocusQuery && explicitFocusQuery)
      ) {
        const routineId = createCatalogEntry.configuredRoutineId.trim();
        return {
          content: `Routine already exists: ${createCatalogEntry.name}`,
          metadata: input.buildFocusMetadata(
            focused,
            'routine',
            [{ id: routineId, label: createCatalogEntry.name }],
            { preferredFocusId: routineId },
          ),
        };
      }
      const createArgs: Record<string, unknown> = {
        templateId: createCatalogEntry.templateId,
        ...(explicitRoutineName ? { name: explicitRoutineName } : {}),
        ...(explicitDelivery?.length ? { delivery: explicitDelivery } : {}),
        ...(explicitScheduleTiming ? { timing: explicitScheduleTiming } : {}),
      };
      if (matchedCatalogEntry?.templateId === 'topic-watch' || createCatalogEntry.templateId === 'topic-watch') {
        const topicQuery = input.routineTopicQuery({
          topicQuery: toString(inferredRoutineCreate?.config?.topicQuery).trim(),
        }) || input.extractQuotedPhrase(input.message.content);
        if (topicQuery) {
          createArgs.config = { topicQuery };
        } else {
          return 'Topic Watch routines need a topic to watch. Try "message me when anything mentions Harbor launch."';
        }
      } else if (matchedCatalogEntry?.templateId === 'deadline-watch' || createCatalogEntry.templateId === 'deadline-watch') {
        const inferredConfig = isRecord(inferredRoutineCreate?.config) ? inferredRoutineCreate.config : null;
        if (inferredConfig) {
          createArgs.config = {
            ...(Number.isFinite(inferredConfig.dueWithinHours) ? { dueWithinHours: Number(inferredConfig.dueWithinHours) } : {}),
            ...(typeof inferredConfig.includeOverdue === 'boolean' ? { includeOverdue: inferredConfig.includeOverdue } : {}),
          };
        }
      } else if (createCatalogEntry.supportsFocusQuery && explicitFocusQuery) {
        createArgs.config = { focusQuery: explicitFocusQuery };
      }
      const matchingRoutine = input.findMatchingRoutineForCreate(configuredRoutines, {
        templateId: createCatalogEntry.templateId,
        timing: explicitScheduleTiming,
        defaultTiming: createCatalogEntry.defaultTiming,
        delivery: explicitDelivery,
        defaultDelivery: createCatalogEntry.defaultDelivery,
        config: createArgs.config,
      });
      if (matchingRoutine?.id) {
        const label = toString(matchingRoutine.name).trim() || createCatalogEntry.name;
        return {
          content: `Routine already exists: ${label}`,
          metadata: input.buildFocusMetadata(
            focused,
            'routine',
            [{ id: matchingRoutine.id, label }],
            { preferredFocusId: matchingRoutine.id },
          ),
        };
      }
      return input.executeMutation({
        message: input.message,
        ctx: input.ctx,
        userKey: input.userKey,
        decision: input.decision,
        toolName: 'second_brain_routine_create',
        args: createArgs,
        summary: 'Creates a Second Brain routine.',
        pendingIntro: 'I prepared that Second Brain routine, but it needs approval first.',
        successDescriptor: {
          itemType: 'routine',
          action: 'create',
          fallbackId: createCatalogEntry.templateId,
          fallbackLabel: createCatalogEntry.name,
        },
        focusState: focused,
      });
    }
    case 'update':
    case 'toggle': {
      if (!matchedRoutineId) {
        return 'I need to know which Second Brain routine to update. Try "Show my routines." first.';
      }
      const existingRoutine = configuredRoutines.find((routine) => routine.id === matchedRoutineId)
        ?? input.secondBrainService.getRoutineById(matchedRoutineId);
      if (!existingRoutine) {
        const label = matchedCatalogEntry?.name ?? focusItem?.label ?? matchedRoutineId;
        return `Second Brain routine "${label}" is not configured yet.`;
      }
      const existingCatalogEntry = routineCatalog.find(
        (entry) => entry.templateId === (existingRoutine.templateId ?? existingRoutine.id),
      ) ?? null;
      const existingRoutineRecord = configuredRoutineRecords.find(
        (routine) => toString(routine.id).trim() === existingRoutine.id,
      )
        ?? (typeof input.secondBrainService.getRoutineRecordById === 'function'
          ? input.secondBrainService.getRoutineRecordById(existingRoutine.id)
          : null)
        ?? (isRecord(existingRoutine) ? existingRoutine as Record<string, unknown> : null);

      const enabledFromDecision = typeof input.decision.entities.enabled === 'boolean'
        ? input.decision.entities.enabled
        : undefined;
      const explicitEnabled = enabledFromDecision ?? input.extractRoutineEnabledState(input.message.content);
      const explicitRoutingBias = input.extractRoutingBias(input.message.content);
      const explicitDeliveryDefaults = input.extractRoutineDeliveryDefaults(input.message.content);
      const explicitLookaheadMinutes = input.extractRoutineLookaheadMinutes(input.message.content);
      const explicitScheduleTiming = input.extractRoutineScheduleTiming(input.message.content);
      const explicitRoutineName = extractRoutineNameOverride(input.message.content);
      const explicitFocusQuery = existingRoutine.focusQuery != null || existingCatalogEntry?.supportsFocusQuery
        ? suppressNameOnlyFocusQuery(
          input.extractRoutineFocusQuery(input.message.content),
          [explicitRoutineName, existingRoutine.name, focusItem?.label],
        )
        : undefined;
      const templateId = existingRoutine.templateId ?? existingRoutine.id;
      const explicitTopicQuery = templateId === 'topic-watch'
        ? input.extractRoutineTopicWatchQuery(input.message.content)
        : undefined;
      const explicitDueWithinHours = templateId === 'deadline-watch'
        ? input.extractRoutineDueWithinHours(input.message.content)
        : undefined;
      const explicitIncludeOverdue = templateId === 'deadline-watch'
        ? input.extractRoutineIncludeOverdue(input.message.content)
        : undefined;
      const existingDelivery = explicitDeliveryDefaults ?? input.routineDeliveryChannels(existingRoutine);
      const existingRoutingBias = typeof existingRoutineRecord?.defaultRoutingBias === 'string'
        ? existingRoutineRecord.defaultRoutingBias
        : undefined;
      const existingBudgetProfileId = typeof existingRoutineRecord?.budgetProfileId === 'string'
        ? existingRoutineRecord.budgetProfileId
        : undefined;
      const existingConfig = isRecord(existingRoutineRecord?.config) ? existingRoutineRecord.config : null;
      const nextArgs: Record<string, unknown> = {
        id: existingRoutine.id,
        name: explicitRoutineName || existingRoutine.name,
        enabled: explicitEnabled ?? existingRoutine.enabled,
        ...(explicitRoutingBias ?? existingRoutingBias ? { defaultRoutingBias: explicitRoutingBias ?? existingRoutingBias } : {}),
        ...(existingBudgetProfileId ? { budgetProfileId: existingBudgetProfileId } : {}),
        ...(existingDelivery.length > 0 ? { delivery: existingDelivery, deliveryDefaults: existingDelivery } : {}),
      };

      const timingKind = input.deriveRoutineTimingKind(existingRoutine)
        ?? input.deriveRoutineTimingKind(existingRoutineRecord ?? {});
      if (explicitScheduleTiming) {
        nextArgs.timing = explicitScheduleTiming;
      } else if (explicitLookaheadMinutes != null) {
        if (timingKind !== 'before_meetings' && timingKind !== 'after_meetings' && timingKind !== 'background') {
          return `${existingRoutine.name} does not use a lookahead window.`;
        }
        nextArgs.timing = {
          kind: timingKind,
          minutes: explicitLookaheadMinutes,
        };
        if (isRecord(existingRoutineRecord?.trigger)) {
          nextArgs.trigger = input.buildToolSafeRoutineTrigger(
            {
              ...existingRoutineRecord.trigger,
              lookaheadMinutes: explicitLookaheadMinutes,
            },
            existingRoutineRecord.trigger,
          );
          if (!nextArgs.trigger) {
            return `I couldn't determine a valid trigger shape for ${existingRoutine.name}.`;
          }
        }
      }

      if (templateId === 'topic-watch' && explicitTopicQuery) {
        nextArgs.config = {
          ...(existingConfig ?? {}),
          topicQuery: explicitTopicQuery,
        };
      } else if (templateId === 'deadline-watch' && (explicitDueWithinHours !== undefined || explicitIncludeOverdue !== undefined)) {
        nextArgs.config = {
          ...(existingConfig ?? {}),
          ...(Number.isFinite(explicitDueWithinHours) ? { dueWithinHours: explicitDueWithinHours } : {}),
          ...(typeof explicitIncludeOverdue === 'boolean' ? { includeOverdue: explicitIncludeOverdue } : {}),
        };
      } else if (explicitFocusQuery !== undefined && existingCatalogEntry?.supportsFocusQuery) {
        nextArgs.config = {
          ...(existingConfig ?? {}),
          focusQuery: explicitFocusQuery,
        };
      }

      const hasExplicitChange = explicitEnabled !== undefined
        || explicitRoutineName !== undefined
        || explicitRoutingBias !== undefined
        || explicitDeliveryDefaults !== undefined
        || explicitLookaheadMinutes !== undefined
        || explicitScheduleTiming !== undefined
        || explicitFocusQuery !== undefined
        || explicitTopicQuery !== undefined
        || explicitDueWithinHours !== undefined
        || explicitIncludeOverdue !== undefined;
      if (!hasExplicitChange) {
        return 'To update that Second Brain routine, tell me what to change, such as enable or disable it, change the delivery channels, adjust when it runs, or update what it watches.';
      }

      return input.executeMutation({
        message: input.message,
        ctx: input.ctx,
        userKey: input.userKey,
        decision: input.decision,
        toolName: 'second_brain_routine_update',
        args: nextArgs,
        summary: 'Updates a Second Brain routine.',
        pendingIntro: 'I prepared that Second Brain routine change, but it needs approval first.',
        successDescriptor: {
          itemType: 'routine',
          action: 'update',
          fallbackId: existingRoutine.id,
          fallbackLabel: explicitRoutineName || existingRoutine.name,
        },
        focusState: focused,
      });
    }
    case 'delete': {
      if (!matchedRoutineId) {
        return 'I need to know which Second Brain routine to delete. Try "Show my routines." first.';
      }
      const existingRoutine = configuredRoutines.find((routine) => routine.id === matchedRoutineId)
        ?? input.secondBrainService.getRoutineById(matchedRoutineId);
      if (!existingRoutine) {
        const label = matchedCatalogEntry?.name ?? focusItem?.label ?? matchedRoutineId;
        return `Second Brain routine "${label}" is not configured yet.`;
      }
      return input.executeMutation({
        message: input.message,
        ctx: input.ctx,
        userKey: input.userKey,
        decision: input.decision,
        toolName: 'second_brain_routine_delete',
        args: { id: existingRoutine.id },
        summary: 'Deletes a Second Brain routine.',
        pendingIntro: 'I prepared that Second Brain routine removal, but it needs approval first.',
        successDescriptor: {
          itemType: 'routine',
          action: 'delete',
          fallbackId: existingRoutine.id,
          fallbackLabel: existingRoutine.name,
        },
        focusState: focused,
      });
    }
    default:
      return null;
  }
}

function extractRoutineNameOverride(text: string): string | undefined {
  const patterns = [
    /\bname\s+it\s*(["'])([\s\S]+?)\1/i,
    /\brenamed?\s+to\s*(["'])([\s\S]+?)\1/i,
    /\bname\s+becomes?\s*(["'])([\s\S]+?)\1/i,
    /\brename\b[\s\S]*?\bto\s*(["'])([\s\S]+?)\1/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const candidate = toString(match?.[2]).trim().replace(/\s+/g, ' ');
    if (candidate) return candidate;
  }
  return undefined;
}

function suppressNameOnlyFocusQuery(
  focusQuery: string | undefined,
  names: Array<string | undefined>,
): string | undefined {
  const normalizedFocus = toString(focusQuery).trim().toLowerCase();
  if (!normalizedFocus) return undefined;
  for (const name of names) {
    if (normalizedFocus === toString(name).trim().toLowerCase()) {
      return undefined;
    }
  }
  return focusQuery;
}
