import { describe, expect, it } from 'vitest';
import { PiiScanner } from './pii-scanner.js';

describe('PiiScanner', () => {
  it('detects street addresses and dates of birth', () => {
    const scanner = new PiiScanner();
    const matches = scanner.scanContent('Patient lives at 123 Main St Apt 4 and DOB: 01/31/1988.');

    expect(matches.map((match) => match.entity)).toEqual(
      expect.arrayContaining(['street_address', 'date_of_birth']),
    );
  });

  it('detects medical record numbers and passport numbers', () => {
    const scanner = new PiiScanner();
    const matches = scanner.scanContent('MRN: A1234567 and passport number: X1234567');

    expect(matches.map((match) => match.entity)).toEqual(
      expect.arrayContaining(['medical_record_number', 'passport']),
    );
  });

  it('redacts detected PII with typed markers', () => {
    const scanner = new PiiScanner();
    const result = scanner.sanitizeContent('Contact jane@example.com at (415) 555-0100.');

    expect(result.matches).toHaveLength(2);
    expect(result.sanitized).toContain('[PII:EMAIL_REDACTED]');
    expect(result.sanitized).toContain('[PII:PHONE_REDACTED]');
    expect(result.sanitized).not.toContain('jane@example.com');
  });

  it('does not treat Apollo mission prose as a street address', () => {
    const scanner = new PiiScanner({ entities: ['street_address'] });
    const result = scanner.sanitizeContent(
      'The Apollo 13 mission had to use command module LiOH filters in place of the lunar module filters.',
    );

    expect(result.matches).toHaveLength(0);
    expect(result.sanitized).toContain('Apollo 13 mission');
  });

  it('supports deterministic anonymization placeholders', () => {
    const scanner = new PiiScanner({ mode: 'anonymize', entities: ['email'] });
    const result = scanner.sanitizeContent('alice@example.com copied alice@example.com');

    expect(result.sanitized).toBe('[PII:EMAIL_1] copied [PII:EMAIL_1]');
  });

  it('filters invalid credit-card candidates with Luhn validation', () => {
    const scanner = new PiiScanner({ entities: ['credit_card'] });
    const invalid = scanner.scanContent('4111111111111112');
    const valid = scanner.scanContent('4111111111111111');

    expect(invalid).toHaveLength(0);
    expect(valid).toHaveLength(1);
  });
});
