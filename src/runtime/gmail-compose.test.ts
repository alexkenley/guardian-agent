import { describe, expect, it } from 'vitest';
import { buildGmailRawMessage, parseDirectGmailWriteIntent } from './gmail-compose.js';

describe('gmail-compose helpers', () => {
  it('parses a send request with labeled fields', () => {
    const intent = parseDirectGmailWriteIntent(
      'send to alexanderkenley@gmail.com subject is test, body testicles123',
    );

    expect(intent).toEqual({
      mode: 'send',
      to: 'alexanderkenley@gmail.com',
      subject: 'test',
      body: 'testicles123',
    });
  });

  it('parses a draft request with missing details', () => {
    const intent = parseDirectGmailWriteIntent('Can you draft a new email?');

    expect(intent).toEqual({
      mode: 'draft',
      to: undefined,
      subject: undefined,
      body: undefined,
    });
  });

  it('defaults structured email details to draft mode', () => {
    const intent = parseDirectGmailWriteIntent(
      'alexanderkenley@gmail.com subject: "Status update" body: "Everything is green."',
    );

    expect(intent).toEqual({
      mode: 'draft',
      to: 'alexanderkenley@gmail.com',
      subject: 'Status update',
      body: 'Everything is green.',
    });
  });

  it('parses natural subject and body phrasing without swallowing connector text', () => {
    const intent = parseDirectGmailWriteIntent(
      'Can you send a new email to alexanderkenley@gmail.com with subject test and in the body put testicles123',
    );

    expect(intent).toEqual({
      mode: 'send',
      to: 'alexanderkenley@gmail.com',
      subject: 'test',
      body: 'testicles123',
    });
  });

  it('parses draft phrasing that uses "subject of"', () => {
    const intent = parseDirectGmailWriteIntent(
      'Draft an email to alexanderkenley@gmail.com with the subject of Test Seven and in the body put testicles.',
    );

    expect(intent).toEqual({
      mode: 'draft',
      to: 'alexanderkenley@gmail.com',
      subject: 'Test Seven',
      body: 'testicles.',
    });
  });

  it('does not treat mailbox read requests as compose requests', () => {
    expect(parseDirectGmailWriteIntent('Who sent the latest Gmail email?')).toBeNull();
  });

  it('builds a base64url-encoded RFC822 Gmail payload', () => {
    const raw = buildGmailRawMessage({
      to: 'alexanderkenley@gmail.com',
      subject: 'test',
      body: 'hello world',
    });

    const decoded = Buffer.from(raw, 'base64url').toString('utf-8');
    expect(decoded).toContain('To: alexanderkenley@gmail.com');
    expect(decoded).toContain('Subject: test');
    expect(decoded).toContain('hello world');
  });
});
