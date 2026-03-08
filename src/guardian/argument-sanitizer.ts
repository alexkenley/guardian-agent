/**
 * Argument sanitizer helpers for tool execution.
 */

import { PiiScanner, type PiiMatch } from './pii-scanner.js';
import { SecretScanner, type SecretMatch } from './secret-scanner.js';

const SHELL_CONTROL_OPERATOR_REGEX = /(?:&&|\|\||[|;&<>`]|(?:^|[^\$])\$\(|\r|\n)/;

const secretScanner = new SecretScanner();
const piiScanner = new PiiScanner();

export interface ShellArgSanitizationResult {
  safe: boolean;
  reason?: string;
}

export interface WriteContentScanResult {
  secrets: SecretMatch[];
  pii: PiiMatch[];
}

export interface ArgSizeValidationResult {
  valid: boolean;
  bytes: number;
  reason?: string;
}

export function sanitizeShellArgs(
  command: string,
  allowedCommands: readonly string[],
): ShellArgSanitizationResult {
  const normalized = command.trim();
  if (!normalized) {
    return { safe: false, reason: 'Command must be a non-empty string.' };
  }

  const isAllowlisted = allowedCommands.some((allowed) => {
    const entry = allowed.trim().toLowerCase();
    const value = normalized.toLowerCase();
    return value === entry || value.startsWith(`${entry} `);
  });
  if (!isAllowlisted) {
    return { safe: false, reason: `Command is not allowlisted: '${normalized}'.` };
  }

  if (SHELL_CONTROL_OPERATOR_REGEX.test(normalized)) {
    return {
      safe: false,
      reason: 'Command contains shell control operators or command substitution.',
    };
  }

  return { safe: true };
}

export function scanWriteContent(content: string): WriteContentScanResult {
  return {
    secrets: secretScanner.scanForSecrets(content),
    pii: piiScanner.scanContent(content),
  };
}

export function validateArgSize(
  args: Record<string, unknown>,
  maxBytes: number,
): ArgSizeValidationResult {
  let serialized = '';
  try {
    serialized = JSON.stringify(args);
  } catch {
    return {
      valid: false,
      bytes: maxBytes + 1,
      reason: 'Tool arguments must be JSON-serializable.',
    };
  }

  const bytes = Buffer.byteLength(serialized, 'utf-8');
  if (bytes > maxBytes) {
    return {
      valid: false,
      bytes,
      reason: `Tool arguments exceed the ${maxBytes} byte limit.`,
    };
  }

  return { valid: true, bytes };
}
