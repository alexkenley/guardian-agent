import { describe, expect, it } from 'vitest';
import {
  parseScheduledEmailAutomationIntent,
  parseScheduledEmailScheduleIntent,
} from './email-automation-intent.js';

describe('parseScheduledEmailAutomationIntent', () => {
  it('parses a daily recurring scheduled email request', () => {
    const intent = parseScheduledEmailAutomationIntent(
      'Grant me an automation to send an email to alexanderkenley@gmail.com at 11:03 PM. Every day, recurring',
      new Date('2026-03-14T10:00:00+10:00'),
    );

    expect(intent).toEqual({
      to: 'alexanderkenley@gmail.com',
      cron: '3 23 * * *',
      runOnce: false,
    });
  });

  it('parses a tomorrow one-shot scheduled email request', () => {
    const intent = parseScheduledEmailAutomationIntent(
      'Create a task to send an email to alexanderkenley@gmail.com tomorrow at 12 pm',
      new Date('2026-03-14T10:00:00+10:00'),
    );

    expect(intent).toEqual({
      to: 'alexanderkenley@gmail.com',
      cron: '0 12 15 3 *',
      runOnce: true,
    });
  });

  it('parses an every-10-minutes recurring scheduled email request', () => {
    const intent = parseScheduledEmailAutomationIntent(
      'Can you send an email every 10 minutes to alexanderkenley@gmail.com?',
      new Date('2026-03-14T10:00:00+10:00'),
    );

    expect(intent).toEqual({
      to: 'alexanderkenley@gmail.com',
      cron: '*/10 * * * *',
      runOnce: false,
    });
  });

  it('parses an hourly recurring scheduled email request', () => {
    const intent = parseScheduledEmailAutomationIntent(
      'Set up an hourly email to alexanderkenley@gmail.com',
      new Date('2026-03-14T10:00:00+10:00'),
    );

    expect(intent).toEqual({
      to: 'alexanderkenley@gmail.com',
      cron: '0 * * * *',
      runOnce: false,
    });
  });

  it('parses an every-one-hour recurring scheduled email request', () => {
    const intent = parseScheduledEmailAutomationIntent(
      'Make it every one hour to alexanderkenley@gmail.com',
      new Date('2026-03-14T10:00:00+10:00'),
    );

    expect(intent).toEqual({
      to: 'alexanderkenley@gmail.com',
      cron: '0 * * * *',
      runOnce: false,
    });
  });

  it('returns null when the request is not about a scheduled email automation', () => {
    expect(parseScheduledEmailAutomationIntent('Send an email to alexanderkenley@gmail.com')).toBeNull();
  });
});

describe('parseScheduledEmailScheduleIntent', () => {
  it('parses a schedule-only hourly clarification', () => {
    const intent = parseScheduledEmailScheduleIntent(
      'Ok, yes, make it every one hour then.',
      new Date('2026-03-14T10:00:00+10:00'),
    );

    expect(intent).toEqual({
      cron: '0 * * * *',
      runOnce: false,
    });
  });
});
