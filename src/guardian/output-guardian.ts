/**
 * Output guardian — scans and redacts secrets from outbound content.
 *
 * Layer 2 defense: intercepts LLM responses, agent outputs, and event
 * payloads before they reach users. Redacts detected secrets instead
 * of blocking entirely, so users get useful responses.
 */

import { redactSensitiveValue } from '../util/crypto-guardrails.js';
import { detectInjectionSignals, stripInvisibleChars } from './input-sanitizer.js';
import { PiiScanner, type PiiEntityType, type PiiMatch, type PiiRedactionMode } from './pii-scanner.js';
import { SecretScanner } from './secret-scanner.js';
import type { SecretMatch } from './secret-scanner.js';

/** Result of scanning outbound content. */
export interface ScanResult {
  /** Whether content is clean (no secrets found). */
  clean: boolean;
  /** Detected secrets. */
  secrets: SecretMatch[];
  /** Content with secrets redacted (if any found). */
  sanitized: string;
}

export interface ToolResultScanOptions {
  providerKind?: 'local' | 'external';
}

export interface PiiRedactionOptions {
  enabled?: boolean;
  mode?: PiiRedactionMode;
  entities?: readonly PiiEntityType[];
  providerScope?: 'all' | 'external';
}

export interface ToolResultScanResult {
  sanitized: unknown;
  threats: string[];
  secrets: SecretMatch[];
  pii: PiiMatch[];
}

interface ToolResultScanState {
  readonly providerKind: 'local' | 'external';
  readonly secrets: SecretMatch[];
  readonly pii: PiiMatch[];
  readonly threats: Set<string>;
}

const SECRET_PATTERNS_HANDLED_AS_PII = new Set([
  'Email Address',
  'US Social Security Number',
  'Credit Card Number',
  'Phone Number (US)',
]);

/**
 * Patterns excluded from outbound LLM response scanning.
 * Email addresses are not credentials — redacting them in prose responses
 * breaks the UX for email/calendar workflows where addresses are user-provided.
 * Email addresses are still gated by the admission controller (SecretScanController)
 * with context-aware exemptions for email/calendar tool actions.
 */
const OUTPUT_EXCLUDED_PATTERNS = new Set([
  'Email Address',
]);

/**
 * Output guardian for scanning and redacting secrets in outbound content.
 *
 * Reuses SecretScanner for pattern matching, but adds redaction logic.
 * Replaces detected secrets with '[REDACTED]' markers.
 */
export class OutputGuardian {
  private readonly scanner: SecretScanner;
  private readonly piiOptions: Required<PiiRedactionOptions>;
  private readonly piiScanner: PiiScanner;
  private readonly injectionThreshold: number;

  constructor(
    additionalPatterns?: string[],
    piiOptions?: PiiRedactionOptions,
    injectionThreshold: number = 3,
  ) {
    this.scanner = new SecretScanner(additionalPatterns);
    this.piiOptions = {
      enabled: piiOptions?.enabled ?? true,
      mode: piiOptions?.mode ?? 'redact',
      entities: [...(piiOptions?.entities ?? [])],
      providerScope: piiOptions?.providerScope ?? 'external',
    };
    this.piiScanner = new PiiScanner({
      entities: this.piiOptions.entities.length > 0 ? this.piiOptions.entities : undefined,
      mode: this.piiOptions.mode,
    });
    this.injectionThreshold = injectionThreshold;
  }

  /** Scan outbound content. Returns cleaned content + any detected secrets.
   *  Email addresses are excluded — they are PII, not credentials, and are
   *  handled separately by the admission controller with context-aware exemptions. */
  scanResponse(content: string): ScanResult {
    const { matches: secrets, sanitized } = this.redactSecrets(content, OUTPUT_EXCLUDED_PATTERNS);
    return { clean: secrets.length === 0, secrets, sanitized };
  }

  /** Scan a serialized event payload for secrets. */
  scanPayload(payload: unknown): SecretMatch[] {
    const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return this.scanner.scanContent(serialized);
  }

  /** Scan arbitrary content string for secrets. */
  scanContent(content: string): SecretMatch[] {
    return this.scanner.scanContent(content);
  }

  /**
   * Scan a tool result before it is injected back into LLM context.
   *
   * Applies secret redaction, optional PII redaction, invisible character
   * stripping, and prompt-injection heuristics to nested string content.
   */
  scanToolResult(_toolName: string, result: unknown, options?: ToolResultScanOptions): ToolResultScanResult {
    const state: ToolResultScanState = {
      providerKind: options?.providerKind ?? 'external',
      secrets: [],
      pii: [],
      threats: new Set<string>(),
    };

    const sanitizedValue = this.scanValue(result, state, 0, new WeakSet<object>());
    const sanitized = redactSensitiveValue(sanitizedValue);

    if (state.secrets.length > 0) {
      state.threats.add(`Redacted ${state.secrets.length} secret match${state.secrets.length === 1 ? '' : 'es'} from tool output.`);
    }
    if (state.pii.length > 0) {
      state.threats.add(`Redacted ${state.pii.length} PII match${state.pii.length === 1 ? '' : 'es'} from tool output.`);
    }

    return {
      sanitized,
      threats: [...state.threats],
      secrets: state.secrets,
      pii: state.pii,
    };
  }

  private scanValue(
    value: unknown,
    state: ToolResultScanState,
    depth: number,
    seen: WeakSet<object>,
  ): unknown {
    if (depth > 8) {
      state.threats.add('Truncated deeply nested tool result content during scanning.');
      return '[TRUNCATED_DEPTH]';
    }

    if (typeof value === 'string') {
      return this.scanString(value, state);
    }

    if (Array.isArray(value)) {
      if (seen.has(value)) {
        state.threats.add('Collapsed circular references in tool output.');
        return '[CIRCULAR]';
      }
      seen.add(value);
      return value.map((entry) => this.scanValue(entry, state, depth + 1, seen));
    }

    if (!value || typeof value !== 'object') {
      return value;
    }

    if (seen.has(value)) {
      state.threats.add('Collapsed circular references in tool output.');
      return '[CIRCULAR]';
    }
    seen.add(value);

    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = this.scanValue(entry, state, depth + 1, seen);
    }
    return output;
  }

  private scanString(value: string, state: ToolResultScanState): string {
    let sanitized = value;

    const stripped = stripInvisibleChars(sanitized);
    if (stripped !== sanitized) {
      state.threats.add('Stripped invisible Unicode from tool output.');
      sanitized = stripped;
    }

    const injection = detectInjectionSignals(sanitized);
    if (injection.score >= this.injectionThreshold) {
      state.threats.add(
        `Potential prompt injection detected in tool output (score: ${injection.score}, signals: ${injection.signals.join(', ')}).`,
      );
    }

    if (this.shouldRedactPii(state.providerKind)) {
      const piiResult = this.piiScanner.sanitizeContent(sanitized);
      if (piiResult.matches.length > 0) {
        state.pii.push(...piiResult.matches);
        sanitized = piiResult.sanitized;
      }
    }

    const secretResult = this.redactSecrets(sanitized, SECRET_PATTERNS_HANDLED_AS_PII);
    if (secretResult.matches.length > 0) {
      state.secrets.push(...secretResult.matches);
      sanitized = secretResult.sanitized;
    }

    return sanitized;
  }

  private shouldRedactPii(providerKind: 'local' | 'external'): boolean {
    if (!this.piiOptions.enabled) {
      return false;
    }
    if (this.piiOptions.providerScope === 'all') {
      return true;
    }
    return providerKind !== 'local';
  }

  private redactSecrets(
    content: string,
    excludedPatterns?: ReadonlySet<string>,
  ): { matches: SecretMatch[]; sanitized: string } {
    const secrets = this.scanner
      .scanForSecrets(content)
      .filter((secret) => !excludedPatterns?.has(secret.pattern));
    if (secrets.length === 0) {
      return { matches: [], sanitized: content };
    }

    const sorted = [...secrets].sort((a, b) => b.offset - a.offset);
    let sanitized = content;
    for (const secret of sorted) {
      const before = sanitized.slice(0, secret.offset);
      const after = sanitized.slice(secret.offset + secret.rawMatch.length);
      sanitized = `${before}[REDACTED]${after}`;
    }

    return { matches: secrets, sanitized };
  }
}
