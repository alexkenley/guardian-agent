import { isRecord, toString } from '../../chat-agent-helpers.js';
import type { IntentGatewayDecision } from '../intent-gateway.js';
import { normalizeTags } from '../second-brain/utils.js';
import type {
  ContinuityThreadContinuationState,
  ContinuityThreadRecord,
} from '../continuity-threads.js';
import type { SelectedExecutionProfile } from '../execution-profiles.js';
import { getProviderTier } from '../../llm/provider-metadata.js';
import {
  getProviderLocalityFromName,
  type ResponseSourceMetadata,
} from '../model-routing-ux.js';

const SECOND_BRAIN_FOCUS_CONTINUATION_KIND = 'second_brain_focus';
const ROUTINE_QUERY_STOP_WORDS = new Set([
  'a',
  'about',
  'all',
  'an',
  'and',
  'any',
  'are',
  'brain',
  'disabled',
  'enabled',
  'for',
  'in',
  'is',
  'list',
  'me',
  'my',
  'of',
  'only',
  'or',
  'processing',
  'related',
  'routine',
  'routines',
  'second',
  'show',
  'the',
  'to',
  'what',
  'which',
]);

type SecondBrainFocusItemType = 'note' | 'task' | 'calendar' | 'person' | 'library' | 'brief' | 'routine';

interface SecondBrainFocusContinuationItem {
  id: string;
  label?: string;
}

interface SecondBrainFocusContinuationEntry {
  focusId?: string;
  items: SecondBrainFocusContinuationItem[];
}

interface SecondBrainFocusContinuationPayload {
  activeItemType?: SecondBrainFocusItemType;
  byType: Partial<Record<SecondBrainFocusItemType, SecondBrainFocusContinuationEntry>>;
}

function normalizeRoutineQueryTokens(query: string | undefined): string[] {
  if (typeof query !== 'string') return [];
  return query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !ROUTINE_QUERY_STOP_WORDS.has(token));
}

function normalizeRoutineSearchTokens(value: string | undefined): string[] {
  if (typeof value !== 'string') return [];
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function deriveRoutineTimingKind(
  routine: {
    timing?: { kind?: string };
    trigger?: { mode?: string; eventType?: string };
  },
): string | undefined {
  if (typeof routine.timing?.kind === 'string' && routine.timing.kind.trim()) {
    return routine.timing.kind.trim();
  }
  const normalizedEventType = typeof routine.trigger?.eventType === 'string'
    ? routine.trigger.eventType.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_')
    : '';
  if (routine.trigger?.mode === 'cron') return 'scheduled';
  if (routine.trigger?.mode === 'event' && normalizedEventType === 'upcoming_event') return 'before_meetings';
  if (routine.trigger?.mode === 'event' && normalizedEventType === 'event_ended') return 'after_meetings';
  if (routine.trigger?.mode === 'horizon') return 'background';
  if (routine.trigger?.mode === 'manual') return 'manual';
  return undefined;
}

function routineTopicQuery(
  routine: {
    topicQuery?: string;
    config?: { topicQuery?: string };
  },
): string {
  return typeof routine.topicQuery === 'string' && routine.topicQuery.trim()
    ? routine.topicQuery.trim()
    : typeof routine.config?.topicQuery === 'string' && routine.config.topicQuery.trim()
      ? routine.config.topicQuery.trim()
      : '';
}

function routineDueWithinHours(
  routine: {
    dueWithinHours?: number;
    config?: { dueWithinHours?: number };
  },
): number | undefined {
  if (Number.isFinite(routine.dueWithinHours)) {
    return Number(routine.dueWithinHours);
  }
  if (Number.isFinite(routine.config?.dueWithinHours)) {
    return Number(routine.config?.dueWithinHours);
  }
  return undefined;
}

function routineIncludeOverdue(
  routine: {
    includeOverdue?: boolean;
    config?: { includeOverdue?: boolean };
  },
): boolean | undefined {
  if (typeof routine.includeOverdue === 'boolean') return routine.includeOverdue;
  if (typeof routine.config?.includeOverdue === 'boolean') return routine.config.includeOverdue;
  return undefined;
}

function routineDeliveryChannels(
  routine: {
    delivery?: string[];
    deliveryDefaults?: string[];
  },
): string[] {
  if (Array.isArray(routine.delivery)) return routine.delivery.filter((value) => typeof value === 'string' && value.trim().length > 0);
  if (Array.isArray(routine.deliveryDefaults)) return routine.deliveryDefaults.filter((value) => typeof value === 'string' && value.trim().length > 0);
  return [];
}

function summarizeRoutineTimingForUser(
  routine: {
    timing?: { label?: string };
    trigger?: { mode?: string; cron?: string; eventType?: string; lookaheadMinutes?: unknown };
  },
): string {
  const label = typeof routine.timing?.label === 'string' ? routine.timing.label.trim() : '';
  return label || formatRoutineTriggerSummaryForUser(routine.trigger);
}

function buildRoutineDeliverySignature(
  delivery: readonly string[] | undefined,
): string[] {
  return [...new Set((delivery ?? [])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim().toLowerCase()))]
    .sort();
}

function buildRoutineScheduleSignature(
  schedule: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(schedule)) return undefined;
  const cadence = toString(schedule.cadence).trim().toLowerCase();
  if (!cadence) return undefined;
  const time = toString(schedule.time).trim();
  const dayOfWeek = toString(schedule.dayOfWeek).trim().toLowerCase();
  return {
    cadence,
    ...(time ? { time } : {}),
    ...(dayOfWeek ? { dayOfWeek } : {}),
    ...(Number.isFinite(schedule.dayOfMonth) ? { dayOfMonth: Number(schedule.dayOfMonth) } : {}),
    ...(Number.isFinite(schedule.minute) ? { minute: Number(schedule.minute) } : {}),
  };
}

function buildRoutineTimingSignature(
  timing: unknown,
): Record<string, unknown> | null {
  if (!isRecord(timing)) return null;
  const kind = toString(timing.kind).trim().toLowerCase();
  if (!kind) return null;
  const schedule = buildRoutineScheduleSignature(timing.schedule);
  const minutes = Number.isFinite(timing.minutes) ? Number(timing.minutes) : undefined;
  return {
    kind,
    ...(schedule ? { schedule } : {}),
    ...(minutes != null ? { minutes } : {}),
  };
}

function buildRoutineCreateDedupSignature(input: {
  templateId: string;
  timing?: unknown;
  defaultTiming?: unknown;
  delivery?: readonly string[];
  defaultDelivery?: readonly string[];
  config?: unknown;
}): string {
  const config = isRecord(input.config) ? input.config : null;
  return JSON.stringify({
    templateId: input.templateId.trim(),
    timing: buildRoutineTimingSignature(input.timing ?? input.defaultTiming),
    delivery: buildRoutineDeliverySignature(input.delivery ?? input.defaultDelivery),
    ...(toString(config?.focusQuery).trim()
      ? { focusQuery: toString(config?.focusQuery).trim().toLowerCase() }
      : {}),
    ...(input.templateId === 'topic-watch' && toString(config?.topicQuery).trim()
      ? { topicQuery: toString(config?.topicQuery).trim().toLowerCase() }
      : {}),
    ...(input.templateId === 'deadline-watch'
      ? {
          dueWithinHours: Number.isFinite(config?.dueWithinHours) ? Number(config?.dueWithinHours) : 24,
          includeOverdue: config?.includeOverdue !== false,
        }
      : {}),
  });
}

function buildRoutineViewDedupSignature(routine: {
  id?: string;
  templateId?: string;
  timing?: unknown;
  trigger?: { mode?: string; eventType?: string; lookaheadMinutes?: unknown };
  delivery?: string[];
  focusQuery?: string;
  topicQuery?: string;
  dueWithinHours?: number;
  includeOverdue?: boolean;
}): string {
  const templateId = toString(routine.templateId).trim() || toString(routine.id).trim();
  const timing = buildRoutineTimingSignature(routine.timing);
  const fallbackTimingKind = deriveRoutineTimingKind({
    timing: isRecord(routine.timing)
      ? { kind: toString(routine.timing.kind).trim() || undefined }
      : undefined,
    trigger: routine.trigger,
  });
  const triggerLookaheadMinutes = routine.trigger?.lookaheadMinutes;
  return JSON.stringify({
    templateId,
    timing: timing ?? (
      fallbackTimingKind
        ? {
            kind: fallbackTimingKind,
            ...(Number.isFinite(triggerLookaheadMinutes)
              ? { minutes: Number(triggerLookaheadMinutes) }
              : {}),
          }
        : null
    ),
    delivery: buildRoutineDeliverySignature(routine.delivery),
    ...(toString(routine.focusQuery).trim()
      ? { focusQuery: toString(routine.focusQuery).trim().toLowerCase() }
      : {}),
    ...(templateId === 'topic-watch' && toString(routine.topicQuery).trim()
      ? { topicQuery: toString(routine.topicQuery).trim().toLowerCase() }
      : {}),
    ...(templateId === 'deadline-watch'
      ? {
          dueWithinHours: Number.isFinite(routine.dueWithinHours) ? Number(routine.dueWithinHours) : 24,
          includeOverdue: routine.includeOverdue !== false,
        }
      : {}),
  });
}

function findMatchingRoutineForCreate(
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
  input: {
    templateId: string;
    timing?: unknown;
    defaultTiming?: unknown;
    delivery?: readonly string[];
    defaultDelivery?: readonly string[];
    config?: unknown;
  },
): {
  id?: string;
  name?: string;
} | null {
  const candidateSignature = buildRoutineCreateDedupSignature(input);
  return routines.find((routine) => (
    (toString(routine.templateId).trim() || toString(routine.id).trim()) === input.templateId
    && buildRoutineViewDedupSignature(routine) === candidateSignature
  )) ?? null;
}

function buildRoutineSemanticHints(
  routine: {
    id?: string;
    templateId?: string;
    name?: string;
    category?: string;
    externalCommMode?: string;
    topicQuery?: string;
    dueWithinHours?: number;
    includeOverdue?: boolean;
    delivery?: string[];
    timing?: { kind?: string };
    config?: { topicQuery?: string; dueWithinHours?: number; includeOverdue?: boolean };
    trigger?: { mode?: string; eventType?: string };
  },
): string[] {
  const hints: string[] = [];
  if (routine.category === 'scheduled') {
    hints.push('scheduled recurring');
  }
  if (routine.externalCommMode === 'draft_only') {
    hints.push('email inbox message draft reply follow up');
  }
  const timingKind = deriveRoutineTimingKind(routine);
  if (timingKind === 'after_meetings') {
    hints.push('post meeting follow up');
  }
  if (timingKind === 'before_meetings') {
    hints.push('meeting prep preparation');
  }
  if ((routine.templateId ?? routine.id) === 'topic-watch') {
    hints.push('watch notify mentions topic tracking');
  }
  if ((routine.templateId ?? routine.id) === 'deadline-watch') {
    hints.push('deadline due soon overdue task pressure reminders');
  }
  const normalizedIdentity = `${routine.id ?? ''} ${routine.templateId ?? ''} ${routine.name ?? ''} ${routineTopicQuery(routine)}`.toLowerCase();
  if (normalizedIdentity.includes('pre-meeting') || normalizedIdentity.includes('pre meeting')) {
    hints.push('meeting prep');
  }
  if (normalizedIdentity.includes('follow-up') || normalizedIdentity.includes('follow up')) {
    hints.push('follow up');
  }
  return hints;
}

const ROUTINE_CRON_DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

function parseRoutineCronNumber(field: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(field)) return null;
  const value = Number(field);
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function parseRoutineCronDays(field: string): number[] | null {
  if (field === '*') return [];
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) return null;
    const rangeMatch = trimmed.match(/^(\d)-(\d)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 7 || start > end) {
        return null;
      }
      for (let day = start; day <= end; day += 1) {
        values.add(day === 7 ? 0 : day);
      }
      continue;
    }
    const value = parseRoutineCronNumber(trimmed, 0, 7);
    if (value == null) return null;
    values.add(value === 7 ? 0 : value);
  }
  return [...values].sort((left, right) => left - right);
}

function sameRoutineDayList(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function joinRoutineWords(values: string[]): string {
  if (values.length <= 1) return values[0] ?? '';
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values[values.length - 1]}`;
}

function formatRoutineMinute(minute: number): string {
  return minute === 0 ? 'on the hour' : `:${String(minute).padStart(2, '0')}`;
}

function formatRoutineTime(hour: number, minute: number): string {
  if (hour === 12 && minute === 0) return 'noon';
  if (hour === 0 && minute === 0) return 'midnight';
  const meridiem = hour >= 12 ? 'p.m.' : 'a.m.';
  const normalizedHour = hour % 12 || 12;
  return minute === 0
    ? `${normalizedHour} ${meridiem}`
    : `${normalizedHour}:${String(minute).padStart(2, '0')} ${meridiem}`;
}

function formatRoutineLookaheadMinutes(minutes: unknown): string {
  if (!Number.isFinite(minutes)) return '';
  const value = Number(minutes);
  if (value % 1440 === 0) {
    const days = value / 1440;
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (value % 60 === 0) {
    const hours = value / 60;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${value} minute${value === 1 ? '' : 's'}`;
}

function summarizeRoutineCronForUser(cron: string | undefined): string {
  const parts = toString(cron).trim().split(/\s+/g);
  if (parts.length !== 5) return 'Custom schedule';
  const [minuteField, hourField, dayOfMonthField, monthField, dayOfWeekField] = parts;
  if (/^\*\/\d+$/.test(minuteField) && hourField === '*' && dayOfMonthField === '*' && monthField === '*' && dayOfWeekField === '*') {
    const interval = Number(minuteField.slice(2));
    return interval === 1 ? 'Every minute' : `Every ${interval} minutes`;
  }
  const minute = parseRoutineCronNumber(minuteField, 0, 59);
  if (minute == null) return 'Custom schedule';
  if (hourField === '*' && dayOfMonthField === '*' && monthField === '*' && dayOfWeekField === '*') {
    return minute === 0 ? 'Hourly' : `Hourly at ${formatRoutineMinute(minute)}`;
  }
  if (/^\*\/\d+$/.test(hourField) && dayOfMonthField === '*' && monthField === '*' && dayOfWeekField === '*') {
    const interval = Number(hourField.slice(2));
    if (interval === 1) {
      return minute === 0 ? 'Hourly' : `Hourly at ${formatRoutineMinute(minute)}`;
    }
    return minute === 0
      ? `Every ${interval} hours on the hour`
      : `Every ${interval} hours at ${formatRoutineMinute(minute)}`;
  }
  const hour = parseRoutineCronNumber(hourField, 0, 23);
  if (hour == null) return 'Custom schedule';
  const time = formatRoutineTime(hour, minute);
  if (dayOfMonthField === '*' && monthField === '*' && dayOfWeekField === '*') {
    return `Daily at ${time}`;
  }
  if (dayOfMonthField === '*' && monthField === '*') {
    const days = parseRoutineCronDays(dayOfWeekField);
    if (days) {
      if (sameRoutineDayList(days, [1, 2, 3, 4, 5])) {
        return `Weekdays at ${time}`;
      }
      if (sameRoutineDayList(days, [0, 6])) {
        return `Weekends at ${time}`;
      }
      if (days.length === 1) {
        return `Every ${ROUTINE_CRON_DAY_NAMES[days[0]]} at ${time}`;
      }
      if (days.length > 1) {
        return `Every ${joinRoutineWords(days.map((day) => ROUTINE_CRON_DAY_NAMES[day]))} at ${time}`;
      }
    }
  }
  const dayOfMonth = parseRoutineCronNumber(dayOfMonthField, 1, 31);
  if (dayOfMonth != null && monthField === '*' && dayOfWeekField === '*') {
    return `Monthly on day ${dayOfMonth} at ${time}`;
  }
  return 'Custom schedule';
}

function formatRoutineTriggerSummaryForUser(
  trigger: { mode?: string; cron?: string; eventType?: string; lookaheadMinutes?: unknown } | undefined,
): string {
  if (!trigger || typeof trigger !== 'object') return 'Run on demand';
  if (trigger.mode === 'cron') {
    return summarizeRoutineCronForUser(trigger.cron);
  }
  if (trigger.mode === 'event') {
    const label = trigger.eventType === 'upcoming_event'
      ? 'Before meetings'
      : trigger.eventType === 'event_ended'
        ? 'After meetings'
        : typeof trigger.eventType === 'string' && trigger.eventType.trim()
          ? trigger.eventType.replaceAll('_', ' ')
          : 'Event-driven';
    const lookahead = formatRoutineLookaheadMinutes(trigger.lookaheadMinutes);
    return lookahead ? `${label} · ${lookahead}` : label;
  }
  if (trigger.mode === 'horizon') {
    const lookahead = formatRoutineLookaheadMinutes(trigger.lookaheadMinutes);
    return lookahead ? `Daily agenda check · ${lookahead}` : 'Daily agenda check';
  }
  return 'Run on demand';
}

function formatBriefKindLabelForUser(kind: string): string {
  return kind
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function isDirectMailboxReplyTarget(value: unknown): value is { to: string; subject: string } {
  return isRecord(value)
    && typeof value.to === 'string'
    && typeof value.subject === 'string';
}

function isSecondBrainFocusItemType(value: string): value is SecondBrainFocusItemType {
  return value === 'note'
    || value === 'task'
    || value === 'calendar'
    || value === 'person'
    || value === 'library'
    || value === 'brief'
    || value === 'routine';
}

function normalizeSecondBrainFocusContinuationItems(value: unknown): SecondBrainFocusContinuationItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => isRecord(entry) && toString(entry.id).trim().length > 0)
    .map((entry) => ({
      id: toString(entry.id).trim(),
      ...(toString(entry.label).trim() ? { label: toString(entry.label).trim() } : {}),
    }));
}

function readSecondBrainFocusContinuationState(
  continuityThread: ContinuityThreadRecord | null | undefined,
): SecondBrainFocusContinuationPayload | null {
  const state = continuityThread?.continuationState;
  if (!state || state.kind !== SECOND_BRAIN_FOCUS_CONTINUATION_KIND) return null;
  const byType: Partial<Record<SecondBrainFocusItemType, SecondBrainFocusContinuationEntry>> = {};
  if (isRecord(state.payload.byType)) {
    for (const [key, rawEntry] of Object.entries(state.payload.byType)) {
      if (!isSecondBrainFocusItemType(key) || !isRecord(rawEntry)) continue;
      const items = normalizeSecondBrainFocusContinuationItems(rawEntry.items);
      if (items.length === 0) continue;
      const focusId = toString(rawEntry.focusId).trim() || undefined;
      byType[key] = {
        ...(focusId && items.some((item) => item.id === focusId) ? { focusId } : {}),
        items,
      };
    }
  }

  const legacyItemType = toString(state.payload.itemType).trim();
  if (isSecondBrainFocusItemType(legacyItemType) && !byType[legacyItemType]) {
    const items = normalizeSecondBrainFocusContinuationItems(state.payload.items);
    if (items.length > 0) {
      const focusId = toString(state.payload.focusId).trim() || undefined;
      byType[legacyItemType] = {
        ...(focusId && items.some((item) => item.id === focusId) ? { focusId } : {}),
        items,
      };
    }
  }

  const availableTypes = Object.keys(byType).filter(isSecondBrainFocusItemType);
  if (availableTypes.length === 0) return null;
  const activeItemType = toString(state.payload.activeItemType).trim();
  const preferredActive = isSecondBrainFocusItemType(activeItemType) && byType[activeItemType]
    ? activeItemType
    : isSecondBrainFocusItemType(legacyItemType) && byType[legacyItemType]
      ? legacyItemType
      : availableTypes[0];
  return {
    activeItemType: preferredActive,
    byType,
  };
}

function getSecondBrainFocusEntry(
  focusState: SecondBrainFocusContinuationPayload | null | undefined,
  itemType: SecondBrainFocusItemType,
): SecondBrainFocusContinuationEntry | null {
  return focusState?.byType[itemType] ?? null;
}

function buildSecondBrainFocusContinuationState(
  existingState: SecondBrainFocusContinuationPayload | null | undefined,
  itemType: SecondBrainFocusItemType,
  items: readonly SecondBrainFocusContinuationItem[],
  options?: { preferredFocusId?: string; fallbackFocusIndex?: number; remove?: boolean; activate?: boolean },
): ContinuityThreadContinuationState | null {
  const byType: Partial<Record<SecondBrainFocusItemType, SecondBrainFocusContinuationEntry>> = {};
  for (const [key, entry] of Object.entries(existingState?.byType ?? {})) {
    if (!isSecondBrainFocusItemType(key) || !entry) continue;
    byType[key] = {
      ...(entry.focusId ? { focusId: entry.focusId } : {}),
      items: entry.items.map((item) => ({ ...item })),
    };
  }

  if (options?.remove) {
    delete byType[itemType];
  } else {
    const normalizedItems = items
      .filter((item) => toString(item.id).trim().length > 0)
      .map((item) => ({
        id: toString(item.id).trim(),
        ...(toString(item.label).trim() ? { label: toString(item.label).trim() } : {}),
      }));
    if (normalizedItems.length === 0) return null;
    const preferredFocusId = toString(options?.preferredFocusId).trim();
    const fallbackIndex = Math.max(0, options?.fallbackFocusIndex ?? 0);
    const focusId = preferredFocusId && normalizedItems.some((item) => item.id === preferredFocusId)
      ? preferredFocusId
      : normalizedItems[Math.min(fallbackIndex, normalizedItems.length - 1)]?.id;
    byType[itemType] = {
      ...(focusId ? { focusId } : {}),
      items: normalizedItems,
    };
  }

  const availableTypes = Object.keys(byType).filter(isSecondBrainFocusItemType);
  if (availableTypes.length === 0) return null;
  const nextActiveItemType = options?.activate === false
    ? (
        existingState?.activeItemType && byType[existingState.activeItemType]
          ? existingState.activeItemType
          : availableTypes[0]
      )
    : (byType[itemType] ? itemType : availableTypes[0]);
  const activeEntry = byType[nextActiveItemType];
  return {
    kind: SECOND_BRAIN_FOCUS_CONTINUATION_KIND,
    payload: {
      activeItemType: nextActiveItemType,
      itemType: nextActiveItemType,
      ...(activeEntry?.focusId ? { focusId: activeEntry.focusId } : {}),
      items: activeEntry?.items.map((item) => ({ ...item })) ?? [],
      byType: Object.fromEntries(
        availableTypes.map((type) => [
          type,
          {
            ...(byType[type]?.focusId ? { focusId: byType[type]?.focusId } : {}),
            items: byType[type]?.items.map((item) => ({ ...item })) ?? [],
          },
        ]),
      ),
    },
  };
}

function buildSecondBrainFocusMetadata(
  existingState: SecondBrainFocusContinuationPayload | null | undefined,
  itemType: SecondBrainFocusItemType,
  items: readonly SecondBrainFocusContinuationItem[],
  options?: { preferredFocusId?: string; fallbackFocusIndex?: number; remove?: boolean; activate?: boolean },
): Record<string, unknown> | undefined {
  const continuationState = buildSecondBrainFocusContinuationState(existingState, itemType, items, options);
  return continuationState ? { continuationState } : undefined;
}

function buildSecondBrainFocusRemovalMetadata(
  existingState: SecondBrainFocusContinuationPayload | null | undefined,
  itemType: SecondBrainFocusItemType,
): Record<string, unknown> {
  return {
    continuationState: buildSecondBrainFocusContinuationState(existingState, itemType, [], { remove: true }),
  };
}

function buildDirectHandlerResponseSource(
  candidate: string,
  selectedExecutionProfile: SelectedExecutionProfile | null | undefined,
  llmProviderName: string | undefined,
): ResponseSourceMetadata | null {
  const notice = candidate === 'personal_assistant'
    ? 'Handled directly by Second Brain.'
    : candidate === 'provider_read'
      ? 'Handled directly by provider tools.'
      : undefined;
  const resolvedProviderName = selectedExecutionProfile?.providerType?.trim()
    || llmProviderName?.trim()
    || '';
  const resolvedLocality = selectedExecutionProfile?.providerLocality
    ?? (resolvedProviderName ? getProviderLocalityFromName(resolvedProviderName) : undefined);
  const resolvedTier = selectedExecutionProfile?.providerTier
    ?? (resolvedProviderName ? getProviderTier(resolvedProviderName) : undefined);
  switch (candidate) {
    case 'personal_assistant':
      if (resolvedLocality) {
        return {
          locality: resolvedLocality,
          ...(resolvedProviderName ? { providerName: resolvedProviderName } : {}),
          ...(selectedExecutionProfile?.providerName
            && selectedExecutionProfile.providerName !== resolvedProviderName
            ? { providerProfileName: selectedExecutionProfile.providerName }
            : {}),
          ...(selectedExecutionProfile?.providerModel
            ? { model: selectedExecutionProfile.providerModel }
            : {}),
          ...(resolvedTier ? { providerTier: resolvedTier } : {}),
          usedFallback: false,
          ...(notice ? { notice } : {}),
        };
      }
      return {
        locality: 'local',
        providerName: 'second_brain',
        usedFallback: false,
        ...(notice ? { notice } : {}),
      };
    case 'provider_read':
      if (resolvedLocality) {
        return {
          locality: resolvedLocality,
          ...(resolvedProviderName ? { providerName: resolvedProviderName } : {}),
          ...(selectedExecutionProfile?.providerName
            && selectedExecutionProfile.providerName !== resolvedProviderName
            ? { providerProfileName: selectedExecutionProfile.providerName }
            : {}),
          ...(selectedExecutionProfile?.providerModel
            ? { model: selectedExecutionProfile.providerModel }
            : {}),
          ...(resolvedTier ? { providerTier: resolvedTier } : {}),
          usedFallback: false,
          ...(notice ? { notice } : {}),
        };
      }
      return {
        locality: 'local',
        providerName: 'control_plane',
        usedFallback: false,
        ...(notice ? { notice } : {}),
      };
    default:
      return null;
  }
}

function buildCodingBackendResponseSource(input: {
  backendId?: string;
  backendName?: string;
  durationMs?: number;
}): ResponseSourceMetadata {
  const backendName = input.backendName?.trim() || input.backendId?.trim() || 'Coding Backend';
  return {
    locality: 'local',
    providerName: backendName,
    providerTier: 'local',
    usedFallback: false,
    notice: `Handled by ${backendName} in the attached workspace.`,
    ...(typeof input.durationMs === 'number' && Number.isFinite(input.durationMs)
      ? { durationMs: Math.max(0, input.durationMs) }
      : {}),
  };
}

function shouldPreferCurrentCodingBackendTask(
  currentTask: string,
  resolvedTask: string,
  backendId?: string,
): boolean {
  const normalizedCurrent = currentTask.trim();
  if (!normalizedCurrent) return false;
  if (!resolvedTask.trim()) return true;
  const lowerCurrent = normalizedCurrent.toLowerCase();
  const normalizedBackend = backendId?.trim().toLowerCase();
  if (normalizedBackend && lowerCurrent.startsWith(`use ${normalizedBackend} for this request:`)) {
    return true;
  }
  return lowerCurrent.startsWith('use ')
    && lowerCurrent.includes(' for this request:');
}

function selectCodingBackendDelegatedTask(input: {
  currentTask: string;
  resolvedTask: string;
  backendId?: string;
}): string {
  if (shouldPreferCurrentCodingBackendTask(input.currentTask, input.resolvedTask, input.backendId)) {
    return input.currentTask.trim();
  }
  return input.resolvedTask.trim() || input.currentTask.trim();
}

function extractQuotedText(text: string): string {
  const match = matchWithCollapsedWhitespaceFallback(text, /(["'])([\s\S]+?)\1/);
  return match?.[2]?.trim() ?? '';
}

const SECOND_BRAIN_WRAPPED_WORD_PREFIX_EXCLUSIONS = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'by',
  'for',
  'from',
  'in',
  'into',
  'is',
  'it',
  'of',
  'on',
  'or',
  'the',
  'to',
  'up',
  'via',
  'with',
]);

function normalizeSecondBrainInlineFieldValue(value: string): string {
  const repairedWrappedWords = value.replace(
    /\b([A-Za-z]{3,4})\s*\n\s+([a-z]{2,})\b/g,
    (_fullMatch, left: string, right: string) => {
      if (SECOND_BRAIN_WRAPPED_WORD_PREFIX_EXCLUSIONS.has(left.toLowerCase())) {
        return `${left} ${right}`;
      }
      return `${left}${right}`;
    },
  );
  return collapseWhitespaceForSecondBrainParsing(repairedWrappedWords);
}

function normalizeSecondBrainReadQueryValue(value: string): string {
  return normalizeSecondBrainInlineFieldValue(value).replace(/^[("'`\s]+|[)"'`.,!?;:\s]+$/g, '').trim();
}

function extractSecondBrainTextBody(text: string): string {
  const sayingMatch = text.match(/\b(?:saying|say|says|write|content)\b\s*:?\s*(["'])([\s\S]+?)\1/i);
  if (sayingMatch?.[2]?.trim()) {
    return sayingMatch[2].trim();
  }
  const quoted = extractQuotedText(text);
  if (quoted) {
    return quoted;
  }

  // Fallback for unquoted natural language bodies
  // Matches "reminding me to XYZ", "saying XYZ", "about XYZ", "that XYZ"
  const unquotedMatch = text.match(/\b(?:reminding\s+me(?:\s+to|\s+that)?|remind\s+me(?:\s+to|\s+that)?|saying(?:\s+that)?|that\s+says|about|to\s+note\s+that|that)\s+([\s\S]+?)(?:$|\n)/i);
  if (unquotedMatch?.[1]?.trim()) {
    return unquotedMatch[1].trim().replace(/[.!?]+$/, '');
  }

  return '';
}

function extractSecondBrainTags(text: string): string[] {
  const labeledQuoted = extractQuotedLabeledValue(text, ['tag', 'tags']);
  if (labeledQuoted) {
    return parseSecondBrainTagList(labeledQuoted);
  }

  const labeledInline = matchWithCollapsedWhitespaceFallback(
    text,
    /\b(?:tags?|tagged)\b(?:\s+(?:are|as|with|include|including))?\s*:?\s*([\s\S]+?)(?=(?:\b(?:with|and)\s+(?:title|content|url|notes?|summary|description|details|due|priority|status|email|phone|company|location)\b)|[.!?]?$)/i,
  );
  return parseSecondBrainTagList(labeledInline?.[1] ?? '');
}

function parseSecondBrainTagList(value: string): string[] {
  return normalizeTags(
    normalizeSecondBrainInlineFieldValue(value)
      .split(/[,;\n]|\s+\band\b\s+/i)
      .map((tag) => tag
        .trim()
        .replace(/^#+/, '')
        .replace(/^[("'`\s]+|[)"'`.,!?;:\s]+$/g, '')
        .trim())
      .filter(Boolean),
  );
}

function extractExplicitNamedSecondBrainTitle(text: string): string {
  const namedMatch = matchWithCollapsedWhitespaceFallback(text, /\b(?:called|named|titled)\s*(["'])([\s\S]+?)\1/i);
  return normalizeSecondBrainInlineFieldValue(namedMatch?.[2]?.trim() ?? '');
}

function extractNamedSecondBrainTitle(text: string): string {
  const explicit = extractExplicitNamedSecondBrainTitle(text);
  if (explicit) {
    return explicit;
  }
  return normalizeSecondBrainInlineFieldValue(extractQuotedText(text));
}

function extractRetitledSecondBrainTitle(text: string): string {
  const patterns = [
    /\brename\b[\s\S]*?\bto\b\s*(["'])([\s\S]+?)\1/i,
    /\b(?:change|update)\b[\s\S]*?\btitle\b[\s\S]*?\bto\b\s*(["'])([\s\S]+?)\1/i,
  ];
  for (const pattern of patterns) {
    const match = matchWithCollapsedWhitespaceFallback(text, pattern);
    const candidate = normalizeSecondBrainInlineFieldValue(match?.[2]?.trim() ?? '');
    if (candidate) {
      return candidate;
    }
  }
  return '';
}

function extractSecondBrainTaskStatus(text: string): 'todo' | 'in_progress' | 'done' | undefined {
  if (/\b(done|complete|completed|finish|finished)\b/i.test(text)) {
    return 'done';
  }
  if (/\b(in[\s-]?progress|started|working on)\b/i.test(text)) {
    return 'in_progress';
  }
  if (/\b(to[\s-]?do|todo|not started)\b/i.test(text)) {
    return 'todo';
  }
  return undefined;
}

function extractSecondBrainTaskPriority(text: string): 'low' | 'medium' | 'high' | undefined {
  const labeled = matchWithCollapsedWhitespaceFallback(
    text,
    /\bpriority\b(?:\s+(?:is|to|as|for|with|include|including))?\s*:?\s*(high|medium|low)\b/i,
  );
  if (labeled?.[1]) {
    return labeled[1].trim().toLowerCase() as 'low' | 'medium' | 'high';
  }
  const inline = matchWithCollapsedWhitespaceFallback(text, /\b(high|medium|low)\s+priority\b/i);
  if (inline?.[1]) {
    return inline[1].trim().toLowerCase() as 'low' | 'medium' | 'high';
  }
  return undefined;
}

function extractQuotedLabeledValue(text: string, labels: string[]): string {
  const escaped = labels
    .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const pattern = new RegExp(`\\b(?:${escaped})\\b(?:\\s+(?:is|to|as|for|with|include|including|becomes?|changes?\\s+to))?\\s*:?\\s*([\"'])([\\s\\S]+?)\\1`, 'i');
  const match = matchWithCollapsedWhitespaceFallback(text, pattern);
  return match?.[2]?.trim() ?? '';
}

function extractEmailAddressFromText(text: string): string {
  const match = matchWithCollapsedWhitespaceFallback(text, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  return match?.[0]?.trim() ?? '';
}

function normalizePhoneNumber(text: string): string {
  const trimmed = text.trim().replace(/^[("']+|[)"',.;:]+$/g, '');
  if (!trimmed) return '';
  const digitCount = trimmed.replace(/\D+/g, '').length;
  if (digitCount < 6) return '';
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return '';
  return trimmed.replace(/\s+/g, ' ');
}

function extractPhoneNumberFromText(text: string): string {
  const labeled = normalizePhoneNumber(extractQuotedLabeledValue(text, ['phone', 'phone number', 'mobile', 'mobile number', 'telephone', 'tel']));
  if (labeled) {
    return labeled;
  }
  const match = matchWithCollapsedWhitespaceFallback(text, /\b(?:phone(?:\s+number)?|mobile(?:\s+number)?|telephone|tel)\b(?:\s+(?:is|to|as|for|with|include|including))?\s*:?[\s"']*([+()\d][\d\s().-]{4,}\d)/i);
  return normalizePhoneNumber(match?.[1] ?? '');
}

function extractUrlFromText(text: string): string {
  const labeled = extractQuotedLabeledValue(text, ['url', 'link']);
  if (labeled) {
    return labeled;
  }
  const pointedTo = matchWithCollapsedWhitespaceFallback(text, /\b(?:pointing|points)\s+to\s*(["'])([\s\S]+?)\1/i);
  if (pointedTo?.[2]) {
    return pointedTo[2].trim();
  }
  const filePath = matchWithCollapsedWhitespaceFallback(text, /\b(?:file|path|reference)\b(?:\s+(?:is|to|as|for|with))?\s*:?\s*(["'])([\s\S]+?)\1/i);
  if (filePath?.[2]) {
    return filePath[2].trim();
  }
  const match = matchWithCollapsedWhitespaceFallback(text, /\bhttps?:\/\/[^\s"'`<>]+/i);
  return match?.[0]?.replace(/[),.;]+$/, '').trim() ?? '';
}

function collapseWhitespaceForSecondBrainParsing(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function matchWithCollapsedWhitespaceFallback(
  text: string,
  pattern: RegExp,
): RegExpMatchArray | null {
  const directMatch = text.match(pattern);
  if (directMatch) {
    return directMatch;
  }
  const collapsed = collapseWhitespaceForSecondBrainParsing(text);
  if (!collapsed || collapsed === text) {
    return null;
  }
  return collapsed.match(pattern);
}

const SECOND_BRAIN_PERSON_NAME_IGNORE = new Set([
  'second brain',
  'google workspace',
  'microsoft 365',
  'ollama cloud',
  'guardian agent',
  'guardian',
]);
const SECOND_BRAIN_PERSON_NAME_FIELD_PATTERN = /^(?:with|phone|email|title|company|location|notes?)\b/i;

function isPlausibleSecondBrainPersonName(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if (SECOND_BRAIN_PERSON_NAME_IGNORE.has(lower)) return false;
  const words = trimmed.split(/\s+/g).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;
  return words.every((word) => /^[A-Z][A-Za-z'-]+$/.test(word));
}

function skipSecondBrainWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/.test(text[index] ?? '')) {
    index += 1;
  }
  return index;
}

function skipSecondBrainNameLeadSeparators(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const char = text[index] ?? '';
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (text.startsWith('...', index)) {
      index += 3;
      continue;
    }
    if (char === '…') {
      index += 1;
      continue;
    }
    if ('-,:;()'.includes(char)) {
      index += 1;
      continue;
    }
    break;
  }
  return index;
}

function readSecondBrainPersonNameWord(
  text: string,
  start: number,
): { word: string; nextIndex: number } | null {
  const match = text.slice(start).match(/^[A-Z][A-Za-z'-]+/);
  if (!match?.[0]) {
    return null;
  }
  return {
    word: match[0],
    nextIndex: start + match[0].length,
  };
}

function hasSecondBrainPersonNameBoundary(text: string, start: number): boolean {
  const boundaryIndex = skipSecondBrainWhitespace(text, start);
  if (boundaryIndex >= text.length) {
    return true;
  }
  if (text.startsWith('...', boundaryIndex) || text.startsWith('…', boundaryIndex)) {
    return true;
  }
  const boundaryChar = text[boundaryIndex] ?? '';
  if (',.;:()'.includes(boundaryChar)) {
    return true;
  }
  return SECOND_BRAIN_PERSON_NAME_FIELD_PATTERN.test(text.slice(boundaryIndex));
}

function extractSecondBrainLeadingPersonName(text: string, start = 0): string {
  let index = skipSecondBrainWhitespace(text, start);
  const words: string[] = [];
  while (words.length < 4) {
    const nextWord = readSecondBrainPersonNameWord(text, index);
    if (!nextWord) {
      break;
    }
    words.push(nextWord.word);
    index = nextWord.nextIndex;
    const nextIndex = skipSecondBrainWhitespace(text, index);
    if (nextIndex === index) {
      break;
    }
    index = nextIndex;
    if (!readSecondBrainPersonNameWord(text, index)) {
      break;
    }
  }
  if (words.length < 2) {
    return '';
  }
  return hasSecondBrainPersonNameBoundary(text, index) ? words.join(' ') : '';
}

function collectSecondBrainFallbackPersonNameCandidates(text: string): string[] {
  const candidates: string[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';
    if (char < 'A' || char > 'Z') {
      continue;
    }
    const previous = text[index - 1] ?? '';
    if ((previous >= 'A' && previous <= 'Z') || (previous >= 'a' && previous <= 'z') || previous === '\'' || previous === '-') {
      continue;
    }
    const candidate = extractSecondBrainLeadingPersonName(text, index);
    if (!candidate) {
      continue;
    }
    candidates.push(candidate);
    index += candidate.length - 1;
  }
  return candidates;
}

function extractSecondBrainFallbackPersonName(text: string): string {
  const labeled = normalizeSecondBrainInlineFieldValue(extractQuotedLabeledValue(text, ['name']));
  if (isPlausibleSecondBrainPersonName(labeled)) {
    return labeled;
  }

  const candidateTexts = [text];
  const collapsed = collapseWhitespaceForSecondBrainParsing(text);
  if (collapsed && collapsed !== text) {
    candidateTexts.push(collapsed);
  }
  for (const candidateText of candidateTexts) {
    for (const match of candidateText.matchAll(/\b(?:named|called)\b/gi)) {
      const candidate = extractSecondBrainLeadingPersonName(candidateText, (match.index ?? 0) + match[0].length);
      if (isPlausibleSecondBrainPersonName(candidate)) {
        return candidate;
      }
    }
    for (const match of candidateText.matchAll(/\b(?:person|contact)\b(?:\s+in\s+my\s+second\s+brain\b)?/gi)) {
      const candidate = extractSecondBrainLeadingPersonName(
        candidateText,
        skipSecondBrainNameLeadSeparators(candidateText, (match.index ?? 0) + match[0].length),
      );
      if (isPlausibleSecondBrainPersonName(candidate)) {
        return candidate;
      }
    }
    const leadingCandidate = extractSecondBrainLeadingPersonName(candidateText);
    if (isPlausibleSecondBrainPersonName(leadingCandidate)) {
      return leadingCandidate;
    }
  }

  const candidates = collectSecondBrainFallbackPersonNameCandidates(candidateTexts.join('\n'))
    .filter(isPlausibleSecondBrainPersonName);
  return candidates[candidates.length - 1] ?? '';
}

function extractSecondBrainPersonRelationship(
  text: string,
): 'work' | 'personal' | 'family' | 'vendor' | 'other' | undefined {
  const match = matchWithCollapsedWhitespaceFallback(text, /\b(?:relationship|as|mark(?:ed)?\s+as)\s+(?:a\s+)?(work|personal|family|vendor|other)\b/i);
  return match?.[1]?.trim().toLowerCase() as 'work' | 'personal' | 'family' | 'vendor' | 'other' | undefined;
}

function extractSecondBrainReadTopicQuery(text: string): string {
  const candidateTexts = [text];
  const collapsed = collapseWhitespaceForSecondBrainParsing(text);
  if (collapsed && collapsed !== text) {
    candidateTexts.push(collapsed);
  }

  const patterns = [
    /\b(?:about|for|related to|matching)\b\s*(["'])([\s\S]+?)\1/i,
    /\b(?:about|for|related to|matching)\b\s+(.+?)(?=$|[.?!])/i,
  ];
  for (const candidateText of candidateTexts) {
    for (const pattern of patterns) {
      const match = candidateText.match(pattern);
      const candidate = normalizeSecondBrainReadQueryValue(match?.[2] ?? match?.[1] ?? '');
      if (candidate) {
        return candidate;
      }
    }
  }
  return '';
}

function resolveDirectSecondBrainReadQuery(
  text: string,
  itemType: string,
  decision: IntentGatewayDecision,
): { query: string; exactMatch?: boolean } | null {
  const explicitQuery = normalizeSecondBrainReadQueryValue(toString(decision.entities.query));
  if (explicitQuery) {
    return { query: explicitQuery };
  }

  switch (itemType) {
    case 'person': {
      const quoted = normalizeSecondBrainReadQueryValue(extractQuotedText(text));
      if (quoted) {
        return { query: quoted, exactMatch: true };
      }
      const named = normalizeSecondBrainReadQueryValue(extractSecondBrainFallbackPersonName(text));
      if (named) {
        return { query: named, exactMatch: true };
      }
      return null;
    }
    case 'library': {
      const topicQuery = extractSecondBrainReadTopicQuery(text);
      if (topicQuery) {
        return { query: topicQuery };
      }
      const quoted = normalizeSecondBrainReadQueryValue(extractQuotedText(text));
      return quoted ? { query: quoted } : null;
    }
    default:
      return null;
  }
}

function normalizeRoutineNameForMatch(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizeRoutineTemplateIdForMatch(value: string): string {
  return value.trim().toLowerCase().replace(/[-_]+/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

function extractRoutineEnabledState(text: string): boolean | undefined {
  if (/\b(?:disable|disabled|pause|paused|deactivate|turn\s+off|stop)\b/i.test(text)) {
    return false;
  }
  if (/\b(?:enable|enabled|resume|resumed|activate|turn\s+on|start)\b/i.test(text)) {
    return true;
  }
  return undefined;
}

function extractSecondBrainRoutingBias(
  text: string,
): 'local_first' | 'balanced' | 'quality_first' | undefined {
  if (/\bquality[\s_-]*first\b/i.test(text)) {
    return 'quality_first';
  }
  if (/\blocal[\s_-]*first\b/i.test(text)) {
    return 'local_first';
  }
  if (/\bbalanced\b/i.test(text)) {
    return 'balanced';
  }
  return undefined;
}

function extractRoutineDeliveryDefaults(
  text: string,
): Array<'web' | 'cli' | 'telegram'> | undefined {
  if (!/\b(?:deliver|delivery|channel|channels|surface|surfaces|send)\b/i.test(text)) {
    return undefined;
  }
  const channels: Array<'web' | 'cli' | 'telegram'> = [];
  if (/\bweb\b/i.test(text)) channels.push('web');
  if (/\bcli\b/i.test(text)) channels.push('cli');
  if (/\btelegram\b/i.test(text)) channels.push('telegram');
  return channels.length > 0 ? channels : undefined;
}

function extractRoutineLookaheadMinutes(text: string): number | undefined {
  if (!/\blookahead\b|\bwindow\b/i.test(text)) {
    return undefined;
  }
  const match = text.match(/\b(\d{1,5})\s*(?:minute|minutes|min)\b/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function extractQuotedPhrase(text: string): string | undefined {
  const match = text.match(/["“]([^"”]+)["”]/);
  const value = match?.[1]?.trim();
  return value ? value : undefined;
}

const ROUTINE_SCHEDULE_WEEKDAY_MAP: Record<string, 'sunday' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday'> = {
  sunday: 'sunday',
  monday: 'monday',
  tuesday: 'tuesday',
  wednesday: 'wednesday',
  thursday: 'thursday',
  friday: 'friday',
  saturday: 'saturday',
};

function parseRoutineClockTimePhrase(text: string): string | undefined {
  const match = text.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i)
    ?? text.match(/\b(?:at\s+)?([01]?\d|2[0-3]):(\d{2})\b/);
  if (!match) return undefined;
  const hourRaw = Number(match[1]);
  const minute = Number(match[2] ?? '0');
  if (!Number.isFinite(hourRaw) || !Number.isFinite(minute) || minute < 0 || minute > 59) {
    return undefined;
  }
  const meridiem = match[3]?.toLowerCase().replace(/\./g, '');
  let hour = hourRaw;
  if (meridiem === 'am') {
    hour = hourRaw === 12 ? 0 : hourRaw;
  } else if (meridiem === 'pm') {
    hour = hourRaw === 12 ? 12 : hourRaw + 12;
  }
  if (hour < 0 || hour > 23) return undefined;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function extractRoutineScheduleTiming(text: string): Record<string, unknown> | undefined {
  const normalized = text.trim();
  if (!normalized) return undefined;
  if (/\b(?:manual only|run on demand|manually)\b/i.test(normalized)) {
    return { kind: 'manual' };
  }
  const hourlyMatch = normalized.match(/\b(?:every|each)\s+hour\b(?:\s+at\s+(?:minute\s+)?)?[: ]?(\d{1,2})?\b/i);
  if (hourlyMatch) {
    const minute = Number(hourlyMatch[1] ?? '0');
    if (Number.isFinite(minute) && minute >= 0 && minute <= 59) {
      return {
        kind: 'scheduled',
        schedule: {
          cadence: 'hourly',
          minute,
        },
      };
    }
  }
  const time = parseRoutineClockTimePhrase(normalized);
  if (!time) return undefined;
  if (/\b(?:weekdays|every weekday|each weekday)\b/i.test(normalized)) {
    return {
      kind: 'scheduled',
      schedule: {
        cadence: 'weekdays',
        time,
      },
    };
  }
  const fortnightlyMatch = normalized.match(/\b(?:fortnightly|biweekly|bi-weekly|every 2 weeks|every other)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
  if (fortnightlyMatch?.[1]) {
    return {
      kind: 'scheduled',
      schedule: {
        cadence: 'fortnightly',
        dayOfWeek: ROUTINE_SCHEDULE_WEEKDAY_MAP[fortnightlyMatch[1].toLowerCase()],
        time,
      },
    };
  }
  const weekdayMatch = normalized.match(/\b(?:every|weekly on|on)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
  if (weekdayMatch?.[1]) {
    return {
      kind: 'scheduled',
      schedule: {
        cadence: 'weekly',
        dayOfWeek: ROUTINE_SCHEDULE_WEEKDAY_MAP[weekdayMatch[1].toLowerCase()],
        time,
      },
    };
  }
  const monthlyMatch = normalized.match(/\b(?:monthly|every month|each month)\s+(?:on\s+)?(?:day\s+)?(\d{1,2})(?:st|nd|rd|th)?\b/i);
  if (monthlyMatch?.[1]) {
    const dayOfMonth = Number(monthlyMatch[1]);
    if (Number.isFinite(dayOfMonth) && dayOfMonth >= 1 && dayOfMonth <= 31) {
      return {
        kind: 'scheduled',
        schedule: {
          cadence: 'monthly',
          dayOfMonth,
          time,
        },
      };
    }
  }
  if (/\b(?:daily|every day|each day)\b/i.test(normalized)) {
    return {
      kind: 'scheduled',
      schedule: {
        cadence: 'daily',
        time,
      },
    };
  }
  return undefined;
}

function extractRoutineTopicWatchQuery(text: string): string | undefined {
  const normalized = text.trim();
  if (!normalized) return undefined;
  const quoted = extractQuotedPhrase(normalized);
  if (quoted) return quoted;
  const trailingMatch = normalized.match(/\b(?:mention|mentions|mentioned|about|related to|watch for|watch)\s+(.+?)(?:[.?!]|$)/i);
  const topicQuery = trailingMatch?.[1]?.trim();
  return topicQuery || undefined;
}

function extractRoutineFocusQuery(text: string): string | undefined {
  const normalized = text.trim();
  if (!normalized) return undefined;
  const quoted = extractQuotedPhrase(normalized);
  if (quoted) return quoted;
  const match = normalized.match(/\b(?:for|about|related to|focused on|focus on)\s+(.+?)(?=\s+\b(?:every|each|daily|weekdays|weekly|fortnightly|monthly|at|before|after|on)\b|[.?!]|$)/i);
  const focusQuery = match?.[1]?.trim();
  return focusQuery || undefined;
}

function extractRoutineDueWithinHours(text: string): number | undefined {
  const normalized = text.trim();
  if (!normalized) return undefined;
  const hourMatch = normalized.match(/\b(\d{1,3})\s*(?:hour|hours)\b/i);
  if (hourMatch?.[1]) {
    const value = Number(hourMatch[1]);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }
  if (/\btomorrow\b/i.test(normalized)) return 24;
  if (/\bnext\s+week\b/i.test(normalized)) return 24 * 7;
  return undefined;
}

function extractRoutineIncludeOverdue(text: string): boolean | undefined {
  const normalized = text.trim();
  if (!normalized) return undefined;
  if (/\b(?:include|with)\s+overdue\b/i.test(normalized) || /\boverdue\b/i.test(normalized)) {
    return true;
  }
  if (/\b(?:without|exclude|excluding|ignore)\s+overdue\b/i.test(normalized) || /\bupcoming tasks only\b/i.test(normalized)) {
    return false;
  }
  return undefined;
}

function extractCustomSecondBrainRoutineCreate(
  text: string,
): {
  templateId: 'topic-watch' | 'deadline-watch' | 'scheduled-review';
  config: Record<string, unknown>;
} | null {
  const normalized = text.trim();
  if (!normalized) return null;

  if (
    /\b(?:scheduled\s+review|review)\b/i.test(normalized)
    && /\b(?:every|each|hourly|daily|weekdays|weekly|fortnightly|monthly|biweekly|bi-weekly|every 2 weeks)\b/i.test(normalized)
  ) {
    return {
      templateId: 'scheduled-review',
      config: {},
    };
  }

  if (/\b(?:due|deadline|overdue)\b/i.test(normalized)) {
    const dueWithinHours = extractRoutineDueWithinHours(normalized);
    const includeOverdue = extractRoutineIncludeOverdue(normalized);
    return {
      templateId: 'deadline-watch',
      config: {
        ...(Number.isFinite(dueWithinHours) ? { dueWithinHours } : {}),
        ...(typeof includeOverdue === 'boolean' ? { includeOverdue } : {}),
      },
    };
  }

  if (/\b(?:mention|mentions|mentioned|about|related to|watch for|watch)\b/i.test(normalized)) {
    const topicQuery = extractRoutineTopicWatchQuery(normalized);
    if (topicQuery) {
      return {
        templateId: 'topic-watch',
        config: { topicQuery },
      };
    }
  }

  return null;
}

function normalizeRoutineTriggerModeForTool(
  value: unknown,
): 'cron' | 'event' | 'horizon' | 'manual' | undefined {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  switch (normalized) {
    case 'cron':
    case 'event':
    case 'horizon':
    case 'manual':
      return normalized;
    default:
      return undefined;
  }
}

function normalizeRoutineEventTypeForTool(
  value: unknown,
): 'upcoming_event' | 'event_ended' | 'task_due' | 'task_overdue' | undefined {
  const normalized = typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    : '';
  switch (normalized) {
    case 'upcoming':
    case 'upcoming_event':
      return 'upcoming_event';
    case 'ended':
    case 'event_ended':
      return 'event_ended';
    case 'task_due':
    case 'due':
      return 'task_due';
    case 'task_overdue':
    case 'overdue':
      return 'task_overdue';
    default:
      return undefined;
  }
}

function buildToolSafeRoutineTrigger(
  trigger: Record<string, unknown> | undefined,
  fallbackTrigger?: Record<string, unknown> | null,
): Record<string, unknown> | undefined {
  const mode = normalizeRoutineTriggerModeForTool(trigger?.mode) ?? normalizeRoutineTriggerModeForTool(fallbackTrigger?.mode);
  if (!mode) return undefined;

  if (mode === 'manual') {
    return { mode };
  }

  if (mode === 'cron') {
    const cron = toString(trigger?.cron).trim() || toString(fallbackTrigger?.cron).trim();
    return cron ? { mode, cron } : { mode };
  }

  if (mode === 'event') {
    const eventType = normalizeRoutineEventTypeForTool(trigger?.eventType)
      ?? normalizeRoutineEventTypeForTool(fallbackTrigger?.eventType);
    const lookaheadMinutes = Number.isFinite(trigger?.lookaheadMinutes)
      ? Number(trigger?.lookaheadMinutes)
      : Number.isFinite(fallbackTrigger?.lookaheadMinutes)
        ? Number(fallbackTrigger?.lookaheadMinutes)
        : undefined;
    return {
      mode,
      ...(eventType ? { eventType } : {}),
      ...(lookaheadMinutes != null ? { lookaheadMinutes } : {}),
    };
  }

  const lookaheadMinutes = Number.isFinite(trigger?.lookaheadMinutes)
    ? Number(trigger?.lookaheadMinutes)
    : Number.isFinite(fallbackTrigger?.lookaheadMinutes)
      ? Number(fallbackTrigger?.lookaheadMinutes)
      : undefined;
  return {
    mode,
    ...(lookaheadMinutes != null ? { lookaheadMinutes } : {}),
  };
}

export type {
  SecondBrainFocusContinuationEntry,
  SecondBrainFocusContinuationItem,
  SecondBrainFocusContinuationPayload,
  SecondBrainFocusItemType,
};

export {
  buildCodingBackendResponseSource,
  buildDirectHandlerResponseSource,
  buildRoutineSemanticHints,
  buildSecondBrainFocusMetadata,
  buildSecondBrainFocusRemovalMetadata,
  buildToolSafeRoutineTrigger,
  collapseWhitespaceForSecondBrainParsing,
  deriveRoutineTimingKind,
  extractCustomSecondBrainRoutineCreate,
  extractEmailAddressFromText,
  extractExplicitNamedSecondBrainTitle,
  extractNamedSecondBrainTitle,
  extractPhoneNumberFromText,
  extractQuotedLabeledValue,
  extractQuotedPhrase,
  extractRetitledSecondBrainTitle,
  extractRoutineDeliveryDefaults,
  extractRoutineDueWithinHours,
  extractRoutineEnabledState,
  extractRoutineFocusQuery,
  extractRoutineIncludeOverdue,
  extractRoutineLookaheadMinutes,
  extractRoutineScheduleTiming,
  extractRoutineTopicWatchQuery,
  extractSecondBrainFallbackPersonName,
  extractSecondBrainPersonRelationship,
  extractSecondBrainRoutingBias,
  extractSecondBrainTags,
  extractSecondBrainTaskPriority,
  extractSecondBrainTaskStatus,
  extractSecondBrainTextBody,
  extractUrlFromText,
  findMatchingRoutineForCreate,
  formatBriefKindLabelForUser,
  getSecondBrainFocusEntry,
  isDirectMailboxReplyTarget,
  isSecondBrainFocusItemType,
  normalizeRoutineNameForMatch,
  normalizeRoutineQueryTokens,
  normalizeRoutineSearchTokens,
  normalizeRoutineTemplateIdForMatch,
  normalizeSecondBrainInlineFieldValue,
  readSecondBrainFocusContinuationState,
  resolveDirectSecondBrainReadQuery,
  routineDeliveryChannels,
  routineDueWithinHours,
  routineIncludeOverdue,
  routineTopicQuery,
  selectCodingBackendDelegatedTask,
  summarizeRoutineTimingForUser,
};
