import type {
  SecondBrainEventRecord,
  SecondBrainPersonRecord,
  SecondBrainTaskRecord,
} from './types.js';

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
}

interface TimeParts {
  hour: number;
  minute: number;
}

interface ParsedTemporalReference {
  date?: LocalDateParts;
  time?: TimeParts;
  endTime?: TimeParts;
  durationMinutes?: number;
}

export interface SecondBrainMutationNormalizationContext {
  toolName: string;
  args: Record<string, unknown>;
  userContent: string;
  referenceTime: number;
  getEventById?: (id: string) => SecondBrainEventRecord | null;
  getTaskById?: (id: string) => SecondBrainTaskRecord | null;
  getPersonById?: (id: string) => SecondBrainPersonRecord | null;
}

const DAY_NAMES = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

const DAY_INDEX = new Map<string, number>(DAY_NAMES.map((name, index) => [name, index]));
const MONTH_INDEX = new Map<string, number>([
  ['january', 1],
  ['february', 2],
  ['march', 3],
  ['april', 4],
  ['may', 5],
  ['june', 6],
  ['july', 7],
  ['august', 8],
  ['september', 9],
  ['october', 10],
  ['november', 11],
  ['december', 12],
]);

export function normalizeSecondBrainMutationArgs(
  input: SecondBrainMutationNormalizationContext,
): Record<string, unknown> {
  switch (input.toolName) {
    case 'second_brain_calendar_upsert':
      return normalizeCalendarMutationArgs(input);
    case 'second_brain_task_upsert':
      return normalizeTaskMutationArgs(input);
    case 'second_brain_person_upsert':
      return normalizePersonMutationArgs(input);
    default:
      return input.args;
  }
}

function normalizeCalendarMutationArgs(
  input: SecondBrainMutationNormalizationContext,
): Record<string, unknown> {
  const parsed = parseTemporalReference(input.userContent, input.referenceTime);
  if (!parsed.date && !parsed.time && !parsed.endTime && parsed.durationMinutes == null) {
    return input.args;
  }

  const nextArgs = { ...input.args };
  const id = asString(nextArgs.id);
  const existing = id ? input.getEventById?.(id) ?? null : null;
  const existingStart = finiteNumber(existing?.startsAt);
  const existingEnd = finiteNumber(existing?.endsAt ?? undefined);
  const argStart = finiteNumber(nextArgs.startsAt);
  const argEnd = finiteNumber(nextArgs.endsAt);
  const baseDate = parsed.date
    ?? localDateFromMs(existingStart ?? argStart ?? input.referenceTime);
  const baseTime = parsed.time
    ?? (existingStart != null ? timeFromMs(existingStart) : undefined);

  const startAt = buildTimestamp(baseDate, baseTime ?? { hour: 9, minute: 0 });
  const durationMinutes = resolveDurationMinutes({
    parsed,
    explicitStart: parsed.time,
    explicitEnd: parsed.endTime,
    existingStart,
    existingEnd,
    argStart,
    argEnd,
    fallbackMinutes: 60,
  });
  const endsAt = parsed.endTime
    ? buildTimestamp(baseDate, parsed.endTime)
    : startAt + durationMinutes * 60_000;

  nextArgs.startsAt = startAt;
  nextArgs.endsAt = endsAt;
  return nextArgs;
}

function normalizeTaskMutationArgs(
  input: SecondBrainMutationNormalizationContext,
): Record<string, unknown> {
  const parsed = parseTemporalReference(input.userContent, input.referenceTime);
  if (!parsed.date && !parsed.time) {
    return input.args;
  }

  const nextArgs = { ...input.args };
  const id = asString(nextArgs.id);
  const existing = id ? input.getTaskById?.(id) ?? null : null;
  const existingDueAt = finiteNumber(existing?.dueAt ?? undefined);
  const baseDate = parsed.date
    ?? localDateFromMs(existingDueAt ?? input.referenceTime);
  const dueAt = buildTimestamp(
    baseDate,
    parsed.time
      ?? (existingDueAt != null ? timeFromMs(existingDueAt) : undefined)
      ?? defaultTaskTime(baseDate, input.referenceTime),
  );

  nextArgs.dueAt = dueAt;
  return nextArgs;
}

function normalizePersonMutationArgs(
  input: SecondBrainMutationNormalizationContext,
): Record<string, unknown> {
  const parsed = parseTemporalReference(input.userContent, input.referenceTime);
  if (!parsed.date && !parsed.time) {
    return input.args;
  }

  const nextArgs = { ...input.args };
  const id = asString(nextArgs.id);
  const existing = id ? input.getPersonById?.(id) ?? null : null;
  const existingLastContactAt = finiteNumber(existing?.lastContactAt ?? undefined);
  const baseDate = parsed.date
    ?? localDateFromMs(existingLastContactAt ?? input.referenceTime);
  const contactAt = buildTimestamp(
    baseDate,
    parsed.time
      ?? (existingLastContactAt != null
        ? timeFromMs(existingLastContactAt)
        : timeFromMs(input.referenceTime)),
  );

  nextArgs.lastContactAt = contactAt;
  return nextArgs;
}

function parseTemporalReference(
  rawText: string,
  referenceTime: number,
): ParsedTemporalReference {
  const text = rawText.trim();
  return {
    date: extractDateParts(text, referenceTime),
    ...extractTimeReference(text),
  };
}

function extractTimeReference(text: string): Omit<ParsedTemporalReference, 'date'> {
  const range = text.match(/\b(?:from\s+)?((?:\d{1,2}(?::\d{2})?\s*[ap]\.?m?\.?)|(?:\d{1,2}:\d{2})|noon|midnight)\s*(?:-|to|until)\s*((?:\d{1,2}(?::\d{2})?\s*[ap]\.?m?\.?)|(?:\d{1,2}:\d{2})|noon|midnight)\b/i);
  if (range) {
    const start = parseTimeToken(range[1]);
    const end = parseTimeToken(range[2]);
    if (start && end) {
      return { time: start, endTime: end };
    }
  }

  const duration = extractDurationMinutes(text);
  const time = extractFirstTime(text);
  return {
    ...(time ? { time } : {}),
    ...(duration != null ? { durationMinutes: duration } : {}),
  };
}

function extractDateParts(text: string, referenceTime: number): LocalDateParts | undefined {
  const lower = text.toLowerCase();
  const referenceDate = new Date(referenceTime);

  if (/\btomorrow\b/i.test(lower)) {
    const next = new Date(referenceDate.getTime());
    next.setDate(next.getDate() + 1);
    return localDateFromMs(next.getTime());
  }
  if (/\btoday\b/i.test(lower)) {
    return localDateFromMs(referenceTime);
  }
  if (/\byesterday\b/i.test(lower)) {
    const previous = new Date(referenceDate.getTime());
    previous.setDate(previous.getDate() - 1);
    return localDateFromMs(previous.getTime());
  }

  const isoDate = lower.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (isoDate) {
    return {
      year: Number.parseInt(isoDate[1], 10),
      month: Number.parseInt(isoDate[2], 10),
      day: Number.parseInt(isoDate[3], 10),
    };
  }

  const monthNameFirst = lower.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,\s*(\d{4}))?\b/);
  if (monthNameFirst) {
    return {
      year: Number.parseInt(monthNameFirst[3] ?? String(referenceDate.getFullYear()), 10),
      month: MONTH_INDEX.get(monthNameFirst[1]) ?? (referenceDate.getMonth() + 1),
      day: Number.parseInt(monthNameFirst[2], 10),
    };
  }

  const monthNameLast = lower.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+(\d{4}))?\b/);
  if (monthNameLast) {
    return {
      year: Number.parseInt(monthNameLast[3] ?? String(referenceDate.getFullYear()), 10),
      month: MONTH_INDEX.get(monthNameLast[2]) ?? (referenceDate.getMonth() + 1),
      day: Number.parseInt(monthNameLast[1], 10),
    };
  }

  const nextDay = lower.match(/\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if (nextDay) {
    return resolveWeekdayDate(referenceDate, nextDay[1], true);
  }

  const explicitDay = lower.match(/\b(?:on|by|for|this)?\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if (explicitDay) {
    return resolveWeekdayDate(referenceDate, explicitDay[1], false);
  }

  return undefined;
}

function resolveWeekdayDate(referenceDate: Date, weekdayName: string, forceNextWeek: boolean): LocalDateParts | undefined {
  const targetDay = DAY_INDEX.get(weekdayName.toLowerCase());
  if (targetDay == null) return undefined;
  const currentDay = referenceDate.getDay();
  let delta = (targetDay - currentDay + 7) % 7;
  if (delta === 0 && forceNextWeek) delta = 7;
  const next = new Date(referenceDate.getTime());
  next.setDate(next.getDate() + delta);
  return localDateFromMs(next.getTime());
}

function extractDurationMinutes(text: string): number | undefined {
  const duration = text.match(/\bfor\s+(?:(an?)\s+)?(\d+)?\s*(hours?|hrs?|minutes?|mins?)\b/i);
  if (!duration) return undefined;
  const amount = duration[1] ? 1 : Number.parseInt(duration[2] ?? '0', 10);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const unit = duration[3].toLowerCase();
  return unit.startsWith('hour') || unit.startsWith('hr')
    ? amount * 60
    : amount;
}

function extractFirstTime(text: string): TimeParts | undefined {
  const tokens = text.match(/\b(?:at\s+|by\s+|before\s+|around\s+)?((?:\d{1,2}(?::\d{2})?\s*[ap]\.?m?\.?)|(?:\d{1,2}:\d{2})|noon|midnight)\b/i);
  return tokens ? parseTimeToken(tokens[1]) : undefined;
}

function parseTimeToken(token: string): TimeParts | undefined {
  const normalized = token.trim().toLowerCase();
  if (normalized === 'noon') return { hour: 12, minute: 0 };
  if (normalized === 'midnight') return { hour: 0, minute: 0 };

  const twelveHour = normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m?\.?$/i);
  if (twelveHour) {
    const rawHour = Number.parseInt(twelveHour[1], 10);
    const minute = Number.parseInt(twelveHour[2] ?? '0', 10);
    if (!Number.isFinite(rawHour) || !Number.isFinite(minute) || rawHour < 1 || rawHour > 12 || minute < 0 || minute > 59) {
      return undefined;
    }
    let hour = rawHour % 12;
    if (twelveHour[3].toLowerCase() === 'p') hour += 12;
    return { hour, minute };
  }

  const twentyFourHour = normalized.match(/^(\d{1,2}):(\d{2})$/);
  if (twentyFourHour) {
    const hour = Number.parseInt(twentyFourHour[1], 10);
    const minute = Number.parseInt(twentyFourHour[2], 10);
    if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      return undefined;
    }
    return { hour, minute };
  }

  return undefined;
}

function resolveDurationMinutes(input: {
  parsed: ParsedTemporalReference;
  explicitStart?: TimeParts;
  explicitEnd?: TimeParts;
  existingStart?: number;
  existingEnd?: number;
  argStart?: number;
  argEnd?: number;
  fallbackMinutes: number;
}): number {
  if (input.explicitStart && input.explicitEnd) {
    const explicit = (input.explicitEnd.hour * 60 + input.explicitEnd.minute)
      - (input.explicitStart.hour * 60 + input.explicitStart.minute);
    if (explicit > 0) return explicit;
  }
  if (input.parsed.durationMinutes != null && input.parsed.durationMinutes > 0) {
    return input.parsed.durationMinutes;
  }
  if (input.existingStart != null && input.existingEnd != null && input.existingEnd > input.existingStart) {
    return Math.round((input.existingEnd - input.existingStart) / 60_000);
  }
  if (input.argStart != null && input.argEnd != null && input.argEnd > input.argStart) {
    return Math.round((input.argEnd - input.argStart) / 60_000);
  }
  return input.fallbackMinutes;
}

function defaultTaskTime(
  targetDate: LocalDateParts,
  referenceTime: number,
): TimeParts {
  const referenceDate = new Date(referenceTime);
  const referenceLocalDate = localDateFromMs(referenceTime);
  const sameDay = isSameDate(targetDate, referenceLocalDate);
  const rawHour = sameDay
    ? Math.min(Math.max(referenceDate.getHours() + 2, 17), 23)
    : 17;
  return { hour: rawHour, minute: 0 };
}

function isSameDate(left: LocalDateParts, right: LocalDateParts): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day;
}

function localDateFromMs(timestamp: number): LocalDateParts {
  const date = new Date(timestamp);
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  };
}

function timeFromMs(timestamp: number): TimeParts {
  const date = new Date(timestamp);
  return {
    hour: date.getHours(),
    minute: date.getMinutes(),
  };
}

function buildTimestamp(date: LocalDateParts, time: TimeParts): number {
  return new Date(date.year, date.month - 1, date.day, time.hour, time.minute, 0, 0).getTime();
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
