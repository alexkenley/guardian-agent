/**
 * PII scanner — detects and redacts personal data in tool results and content.
 *
 * Uses targeted regular expressions instead of heavyweight NER dependencies so
 * it can run inline in the Guardian pipeline.
 */

export type PiiEntityType =
  | 'email'
  | 'ssn'
  | 'credit_card'
  | 'phone'
  | 'street_address'
  | 'date_of_birth'
  | 'medical_record_number'
  | 'passport'
  | 'drivers_license';

export type PiiRedactionMode = 'redact' | 'anonymize';

export interface PiiMatch {
  entity: PiiEntityType;
  label: string;
  match: string;
  rawMatch: string;
  offset: number;
}

export interface PiiScanResult {
  matches: PiiMatch[];
  sanitized: string;
}

export interface PiiScannerOptions {
  entities?: readonly PiiEntityType[];
  mode?: PiiRedactionMode;
}

interface PiiPattern {
  entity: PiiEntityType;
  label: string;
  regex: RegExp;
  validator?: (match: string) => boolean;
}

export const DEFAULT_PII_ENTITIES: readonly PiiEntityType[] = [
  'email',
  'ssn',
  'credit_card',
  'phone',
  'street_address',
  'date_of_birth',
  'medical_record_number',
  'passport',
  'drivers_license',
];

export const DEFAULT_VALIDATION_PII_ENTITIES: readonly PiiEntityType[] = [
  'street_address',
  'date_of_birth',
  'medical_record_number',
  'passport',
  'drivers_license',
];

const MONTH_NAMES = '(?:jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)';

const BUILTIN_PATTERNS: readonly PiiPattern[] = [
  {
    entity: 'email',
    label: 'Email Address',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
  },
  {
    entity: 'ssn',
    label: 'US Social Security Number',
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  {
    entity: 'credit_card',
    label: 'Credit Card Number',
    regex: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|3(?:0[0-5]|[68][0-9])[0-9]{11}|6(?:011|5[0-9]{2})[0-9]{12}|(?:2131|1800|35\d{3})\d{11})\b/g,
    validator: passesLuhnCheck,
  },
  {
    entity: 'phone',
    label: 'Phone Number (US)',
    regex: /\b(?:\+?1[-.\s]?)?\(?[2-9]\d{2}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
  },
  {
    entity: 'street_address',
    label: 'Street Address',
    regex: /\b(?:P\.?\s*O\.?\s*Box\s+\d{1,6}|(?:\d{1,6}\s+(?:[A-Za-z0-9.'#-]+\s+){0,5}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Circle|Cir|Way|Place|Pl|Terrace|Ter|Trail|Trl|Parkway|Pkwy)\b(?:\s+(?:Apt|Apartment|Suite|Ste|Unit|#)\s*[A-Za-z0-9-]+)?))/gi,
  },
  {
    entity: 'date_of_birth',
    label: 'Date of Birth',
    regex: new RegExp(
      `\\b(?:dob|date\\s+of\\s+birth|birth\\s*date|birthday|born)\\b[^\\n\\r]{0,16}?[:#-]?\\s*(?:\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4}|\\d{4}[/-]\\d{1,2}[/-]\\d{1,2}|${MONTH_NAMES}\\s+\\d{1,2},?\\s+\\d{4})`,
      'gi',
    ),
  },
  {
    entity: 'medical_record_number',
    label: 'Medical Record Number',
    regex: /\b(?:mrn|medical\s+record(?:\s+number|\s+no\.?)?)\b[^\n\r]{0,12}?[:#-]?\s*[A-Z0-9-]{6,14}\b/gi,
  },
  {
    entity: 'passport',
    label: 'Passport Number',
    regex: /\b(?:passport(?:\s+number|\s+no\.?)?)\b[^\n\r]{0,12}?[:#-]?\s*[A-Z0-9]{6,9}\b/gi,
  },
  {
    entity: 'drivers_license',
    label: "Driver's License",
    regex: /\b(?:driver'?s?\s+licen[sc]e(?:\s+number|\s+no\.?)?|licen[sc]e\s+number)\b[^\n\r]{0,12}?[:#-]?\s*[A-Z0-9-]{5,16}\b/gi,
  },
];

export class PiiScanner {
  private readonly patterns: readonly PiiPattern[];
  private readonly mode: PiiRedactionMode;
  private readonly anonymizedValues = new Map<string, string>();
  private anonymizeCounter = 0;

  constructor(options?: PiiScannerOptions) {
    const enabled = new Set(options?.entities ?? DEFAULT_PII_ENTITIES);
    this.patterns = BUILTIN_PATTERNS.filter((pattern) => enabled.has(pattern.entity));
    this.mode = options?.mode ?? 'redact';
  }

  scanContent(content: string): PiiMatch[] {
    const matches: PiiMatch[] = [];

    for (const pattern of this.patterns) {
      pattern.regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.regex.exec(content)) !== null) {
        const rawMatch = match[0];
        if (pattern.validator && !pattern.validator(rawMatch)) {
          continue;
        }
        matches.push({
          entity: pattern.entity,
          label: pattern.label,
          match: redactPreview(rawMatch),
          rawMatch,
          offset: match.index,
        });
      }
    }

    return matches;
  }

  sanitizeContent(content: string): PiiScanResult {
    const matches = this.scanContent(content);
    if (matches.length === 0) {
      return { matches: [], sanitized: content };
    }

    const sorted = [...matches].sort((a, b) => b.offset - a.offset);
    let sanitized = content;
    for (const match of sorted) {
      const before = sanitized.slice(0, match.offset);
      const after = sanitized.slice(match.offset + match.rawMatch.length);
      sanitized = before + this.getReplacement(match) + after;
    }

    return { matches, sanitized };
  }

  private getReplacement(match: PiiMatch): string {
    if (this.mode === 'anonymize') {
      const key = `${match.entity}:${match.rawMatch.toLowerCase()}`;
      const existing = this.anonymizedValues.get(key);
      if (existing) {
        return existing;
      }

      const replacement = `[PII:${toMarker(match.entity)}_${++this.anonymizeCounter}]`;
      this.anonymizedValues.set(key, replacement);
      return replacement;
    }

    return `[PII:${toMarker(match.entity)}_REDACTED]`;
  }
}

function redactPreview(value: string): string {
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function toMarker(entity: PiiEntityType): string {
  switch (entity) {
    case 'street_address':
      return 'ADDRESS';
    case 'date_of_birth':
      return 'DOB';
    case 'medical_record_number':
      return 'MRN';
    case 'drivers_license':
      return 'DRIVERS_LICENSE';
    case 'credit_card':
      return 'CREDIT_CARD';
    default:
      return entity.toUpperCase();
  }
}

function passesLuhnCheck(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = Number(digits[i]);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }

  return sum % 10 === 0;
}
