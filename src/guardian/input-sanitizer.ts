/**
 * Input sanitizer — admission controller for prompt injection detection.
 *
 * Layer 1 defense: detects and neutralizes prompt injection attempts
 * by stripping invisible Unicode characters and scoring injection signals.
 * This is a mutating controller — it cleans content before validators run.
 */

import type { AdmissionController, AdmissionPhase, AdmissionResult, AgentAction } from './guardian.js';

/** Configuration for input sanitization. */
export interface InputSanitizerConfig {
  /** Score threshold to block input (default: 3). */
  blockThreshold: number;
  /** Whether to strip invisible Unicode characters (default: true). */
  stripInvisible: boolean;
}

const DEFAULT_CONFIG: InputSanitizerConfig = {
  blockThreshold: 3,
  stripInvisible: true,
};

/**
 * Invisible Unicode characters that could be used to hide instructions.
 * Includes zero-width joiners, bidi markers, soft hyphens, etc.
 */
const INVISIBLE_CHAR_REGEX = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E]/g;

/**
 * Injection signature patterns and their scores.
 * Higher score = more likely to be injection.
 */
const INJECTION_SIGNALS: Array<{ pattern: RegExp; score: number; name: string }> = [
  // Role override attempts
  { pattern: /\bignore\s+(?:all\s+)?previous\s+(?:instructions?|prompts?|rules?)\b/i, score: 3, name: 'role_override_ignore' },
  { pattern: /\byou\s+are\s+now\b/i, score: 2, name: 'role_override_identity' },
  { pattern: /\bforget\s+(?:all\s+)?(?:your\s+)?(?:previous\s+)?instructions?\b/i, score: 3, name: 'role_override_forget' },
  { pattern: /\bact\s+as\s+(?:a\s+|an\s+)?/i, score: 1, name: 'role_override_act' },
  { pattern: /\bpretend\s+(?:you\s+are|to\s+be)\b/i, score: 2, name: 'role_override_pretend' },

  // Delimiter injection (fake message boundaries)
  { pattern: /^system\s*:/im, score: 3, name: 'delimiter_system' },
  { pattern: /^assistant\s*:/im, score: 2, name: 'delimiter_assistant' },
  { pattern: /^user\s*:/im, score: 1, name: 'delimiter_user' },
  { pattern: /```\s*system\b/i, score: 2, name: 'delimiter_code_system' },

  // Instruction override patterns
  { pattern: /\bnew\s+instructions?\s*:/i, score: 3, name: 'instruction_override' },
  { pattern: /\boverride\s+(?:all\s+)?(?:previous\s+)?(?:instructions?|settings?|rules?)\b/i, score: 3, name: 'instruction_override_explicit' },
  { pattern: /\bdo\s+not\s+follow\s+(?:any|the|your)\s+(?:previous\s+)?(?:instructions?|rules?)\b/i, score: 3, name: 'instruction_override_negative' },

  // Jailbreak patterns
  { pattern: /\bDAN\s+mode\b/i, score: 3, name: 'jailbreak_dan' },
  { pattern: /\bdeveloper\s+mode\b/i, score: 2, name: 'jailbreak_developer' },
  { pattern: /\bjailbreak\b/i, score: 2, name: 'jailbreak_keyword' },

  // Data exfiltration patterns
  { pattern: /\brepeat\s+(?:all\s+|the\s+)?(?:above|previous|system)\b/i, score: 2, name: 'exfil_repeat' },
  { pattern: /\bshow\s+(?:me\s+)?(?:your\s+)?(?:system\s+)?(?:prompt|instructions?)\b/i, score: 2, name: 'exfil_show_prompt' },
  { pattern: /\bwhat\s+(?:are|were)\s+your\s+(?:original\s+)?instructions?\b/i, score: 2, name: 'exfil_what_instructions' },
];

/** Strip invisible Unicode characters from content. */
export function stripInvisibleChars(content: string): string {
  return content.replace(INVISIBLE_CHAR_REGEX, '');
}

/** Detect injection signals in content. Returns total score and matched signals. */
export function detectInjection(content: string): { score: number; signals: string[] } {
  const normalized = normalizeInjectionText(content);
  let score = 0;
  const signals: string[] = [];

  for (const { pattern, score: signalScore, name } of INJECTION_SIGNALS) {
    pattern.lastIndex = 0;
    const matchedRaw = pattern.test(content);
    pattern.lastIndex = 0;
    const matchedNormalized = pattern.test(normalized);
    if (matchedRaw || matchedNormalized) {
      score += signalScore;
      signals.push(matchedNormalized && !matchedRaw ? `${name}_normalized` : name);
    }
  }

  return { score, signals };
}

/** Backwards-compatible alias for callers that want the lower-level utility. */
export const detectInjectionSignals = detectInjection;

function normalizeInjectionText(content: string): string {
  return content
    .normalize('NFKC')
    .toLowerCase()
    // Collapse obfuscated separators inside words (e.g., "ig-nore" -> "ignore").
    .replace(/(?<=[a-z])[_\-.]+(?=[a-z])/g, '')
    .replace(/[0@]/g, 'o')
    .replace(/[1!|]/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/7/g, 't')
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Input sanitization admission controller.
 *
 * Mutating phase: cleans invisible characters and detects injection attempts.
 * If injection score exceeds threshold, the action is denied.
 * If invisible characters were stripped, the action is mutated with cleaned content.
 */
export class InputSanitizer implements AdmissionController {
  readonly name = 'InputSanitizer';
  readonly phase: AdmissionPhase = 'mutating';
  private config: InputSanitizerConfig;

  constructor(config?: Partial<InputSanitizerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  check(action: AgentAction): AdmissionResult | null {
    const content = action.params['content'] as string | undefined;
    if (!content) return null;

    let cleaned = content;

    // Step 1: Strip invisible Unicode characters
    if (this.config.stripInvisible) {
      cleaned = stripInvisibleChars(content);
    }

    // Step 2: Detect injection signatures
    const { score, signals } = detectInjection(cleaned);

    if (score >= this.config.blockThreshold) {
      return {
        allowed: false,
        reason: `Prompt injection detected (score: ${score}, signals: ${signals.join(', ')})`,
        controller: this.name,
      };
    }

    // Step 3: If content was mutated (invisible chars stripped), return mutation
    if (cleaned !== content) {
      return {
        allowed: true,
        controller: this.name,
        mutatedAction: {
          ...action,
          params: { ...action.params, content: cleaned },
        },
      };
    }

    return null;
  }
}
