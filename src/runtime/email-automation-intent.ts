export interface ScheduledEmailAutomationIntent {
  to: string;
  cron: string;
  runOnce: boolean;
}

export interface ScheduledEmailScheduleIntent {
  cron: string;
  runOnce: boolean;
}

const EMAIL_ADDRESS_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const SCHEDULE_SIGNAL_PATTERN = /\b(automation|task|schedule|scheduled|remind|reminder|recurring|every day|daily|tomorrow|hourly|every hour|each hour|every one hour|every minute|every \d+ minutes?)\b/i;

export function parseScheduledEmailAutomationIntent(
  content: string,
  now: Date = new Date(),
): ScheduledEmailAutomationIntent | null {
  const text = content.trim();
  if (!text) return null;
  if (!/\b(send|email|gmail|mail)\b/i.test(text)) return null;
  if (!SCHEDULE_SIGNAL_PATTERN.test(text)) return null;

  const to = extractRecipient(text);
  if (!to) return null;

  const schedule = parseScheduledEmailScheduleIntent(text, now);
  if (!schedule) return null;
  return { to, ...schedule };
}

export function parseScheduledEmailScheduleIntent(
  content: string,
  now: Date = new Date(),
): ScheduledEmailScheduleIntent | null {
  const text = content.trim();
  if (!text) return null;
  if (!SCHEDULE_SIGNAL_PATTERN.test(text)) return null;

  const everyMinutes = extractEveryMinutes(text);
  if (everyMinutes) {
    return {
      cron: everyMinutes === 1 ? '* * * * *' : `*/${everyMinutes} * * * *`,
      runOnce: false,
    };
  }

  if (/\b(hourly|every hour|each hour|every one hour)\b/i.test(text)) {
    return {
      cron: '0 * * * *',
      runOnce: false,
    };
  }

  const time = extractTime(text);
  if (!time) return null;

  if (/\b(every day|daily|recurring|each day)\b/i.test(text)) {
    return {
      cron: `${time.minute} ${time.hour} * * *`,
      runOnce: false,
    };
  }

  if (/\btomorrow\b/i.test(text)) {
    const target = new Date(now.getTime());
    target.setDate(target.getDate() + 1);
    return {
      cron: `${time.minute} ${time.hour} ${target.getDate()} ${target.getMonth() + 1} *`,
      runOnce: true,
    };
  }

  return null;
}

function extractRecipient(text: string): string {
  const labeled = text.match(/\b(?:to|recipient|email\s+to|send\s+to)\s*(?:is\s*)?<?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})>?/i);
  if (labeled?.[1]) return labeled[1].trim();
  return text.match(EMAIL_ADDRESS_PATTERN)?.[0]?.trim() ?? '';
}

function extractTime(text: string): { hour: number; minute: number } | null {
  const twelveHour = text.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m?\.?\b/i);
  if (twelveHour) {
    const rawHour = Number.parseInt(twelveHour[1], 10);
    const minute = Number.parseInt(twelveHour[2] ?? '0', 10);
    if (!Number.isFinite(rawHour) || !Number.isFinite(minute) || rawHour < 1 || rawHour > 12 || minute < 0 || minute > 59) {
      return null;
    }
    const meridiem = twelveHour[3].toLowerCase();
    let hour = rawHour % 12;
    if (meridiem === 'p') hour += 12;
    return { hour, minute };
  }

  const twentyFourHour = text.match(/\bat\s+(\d{1,2}):(\d{2})\b/i);
  if (twentyFourHour) {
    const hour = Number.parseInt(twentyFourHour[1], 10);
    const minute = Number.parseInt(twentyFourHour[2], 10);
    if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      return null;
    }
    return { hour, minute };
  }

  return null;
}

function extractEveryMinutes(text: string): number | null {
  const digitMatch = text.match(/\bevery\s+(\d+)\s+minutes?\b/i);
  if (digitMatch) {
    const parsed = Number.parseInt(digitMatch[1], 10);
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 59) return parsed;
    return null;
  }

  if (/\bevery minute\b/i.test(text)) {
    return 1;
  }

  return null;
}
