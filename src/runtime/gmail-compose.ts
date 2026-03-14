export interface DirectGmailWriteIntent {
  mode: 'draft' | 'send';
  to?: string;
  subject?: string;
  body?: string;
}

const EMAIL_ADDRESS_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const WRITE_SIGNAL_PATTERN = /\b(send|draft|compose|write|reply|forward)\b/i;
const MAILBOX_SIGNAL_PATTERN = /\b(gmail|email|mail)\b/i;
const DETAIL_SIGNAL_PATTERN = /\b(subject|body|message|recipient)\b/i;
const LABELED_RECIPIENT_PATTERN = /\bto\s+<?[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}>?/i;

export function parseDirectGmailWriteIntent(content: string): DirectGmailWriteIntent | null {
  const text = content.trim();
  if (!text) return null;

  const hasWriteSignal = WRITE_SIGNAL_PATTERN.test(text);
  const hasMailboxSignal = MAILBOX_SIGNAL_PATTERN.test(text);
  const hasDetailSignal = DETAIL_SIGNAL_PATTERN.test(text);
  const hasAddress = EMAIL_ADDRESS_PATTERN.test(text);
  const hasStructuredSignal = hasDetailSignal
    || LABELED_RECIPIENT_PATTERN.test(text)
    || (hasAddress && /\b(subject|body|message)\b/i.test(text));

  if (!hasStructuredSignal && !(hasWriteSignal && hasMailboxSignal)) {
    return null;
  }

  const mode: DirectGmailWriteIntent['mode'] = /\bsend\b/i.test(text) ? 'send' : 'draft';

  const to = extractRecipient(text);
  const subject = extractLabeledValue(text, 'subject', ['body', 'message']);
  const body = extractLabeledValue(text, 'body', [], { stripLeadIn: true })
    || extractLabeledValue(text, 'message', [], { stripLeadIn: true });

  return {
    mode,
    to: to || undefined,
    subject: subject || undefined,
    body: body || undefined,
  };
}

export function buildGmailRawMessage(input: {
  to: string;
  subject: string;
  body: string;
}): string {
  const rawMessage = [
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    input.body,
    '',
  ].join('\r\n');
  return Buffer.from(rawMessage, 'utf-8').toString('base64url');
}

function extractRecipient(text: string): string {
  const labeled = text.match(/\b(?:to|recipient|email\s+to|send\s+to)\s*(?:is\s*)?<?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})>?/i);
  if (labeled?.[1]) {
    return labeled[1].trim();
  }

  const firstEmail = text.match(EMAIL_ADDRESS_PATTERN);
  return firstEmail?.[0]?.trim() ?? '';
}

function extractLabeledValue(
  text: string,
  label: string,
  stopLabels: string[],
  options?: { stripLeadIn?: boolean },
): string {
  const stopPattern = stopLabels.length > 0
    ? `(?=(?:,?\\s*(?:and\\s+)?(?:in\\s+the\\s+)?)?\\b(?:${stopLabels.join('|')})\\b(?:\\s+of|\\s+is|\\s*:|\\s*=)?\\s*|$)`
    : '$';
  const pattern = new RegExp(
    `\\b${label}\\b(?:\\s+of|\\s+is|\\s*:|\\s*=)?\\s*([\\s\\S]+?)${stopPattern}`,
    'i',
  );
  const match = text.match(pattern);
  return normalizeExtractedValue(match?.[1] ?? '', options);
}

function normalizeExtractedValue(value: string, options?: { stripLeadIn?: boolean }): string {
  let trimmed = value.trim().replace(/^,\s*/, '').trim();
  trimmed = stripWrappingQuotes(trimmed);
  if (options?.stripLeadIn) {
    trimmed = trimmed.replace(/^(?:put|say|write|as)\b[:\s-]*/i, '').trim();
  }
  return stripWrappingQuotes(trimmed);
}

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith('\'') && value.endsWith('\''))
  ) {
    return value.slice(1, -1).trim();
  }
  return value;
}
