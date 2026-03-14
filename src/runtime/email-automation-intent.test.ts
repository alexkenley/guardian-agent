import { describe, expect, it } from 'vitest';
import { parseScheduledEmailAutomationIntent } from './email-automation-intent.js';

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

  it('returns null when the request is not about a scheduled email automation', () => {
    expect(parseScheduledEmailAutomationIntent('Send an email to alexanderkenley@gmail.com')).toBeNull();
  });
});
