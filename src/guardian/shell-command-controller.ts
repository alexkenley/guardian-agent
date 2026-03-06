/**
 * Shell command admission controller.
 *
 * Validates shell commands before execution by tokenizing them,
 * splitting on chain operators, and checking each sub-command
 * against an allowed list and denied paths.
 */

import type { AdmissionController, AdmissionPhase, AdmissionResult, AgentAction } from './guardian.js';
import { validateShellCommand } from './shell-validator.js';
import { SecretScanner } from './secret-scanner.js';

export interface ShellCommandControllerConfig {
  /** Allowed command prefixes (e.g., ['git', 'npm', 'node']). */
  allowedCommands: string[];
  /** Additional secret patterns for denied path checking. */
  additionalSecretPatterns?: string[];
  /** Additional denied paths. */
  deniedPaths?: string[];
}

/**
 * Admission controller that validates shell commands.
 *
 * Only fires on `action.type === 'execute_command'`.
 * Tokenizes the command, validates sub-commands against allowed list,
 * and checks arguments against denied paths.
 */
export class ShellCommandController implements AdmissionController {
  readonly name = 'ShellCommandController';
  readonly phase: AdmissionPhase = 'validating';

  private allowedCommands: string[];
  private readonly scanner: SecretScanner;

  constructor(config: ShellCommandControllerConfig) {
    this.allowedCommands = normalizeAllowedCommands(config.allowedCommands);
    this.scanner = new SecretScanner(config.additionalSecretPatterns);
    if (config.deniedPaths && config.deniedPaths.length > 0) {
      this.scanner.addDeniedPaths(config.deniedPaths);
    }
  }

  /** Update allowlisted command prefixes without recreating the controller. */
  updateAllowedCommands(allowedCommands: string[]): void {
    this.allowedCommands = normalizeAllowedCommands(allowedCommands);
  }

  check(action: AgentAction): AdmissionResult | null {
    if (action.type !== 'execute_command') {
      return null; // Pass through — not a shell command
    }

    const command = action.params['command'] as string | undefined;
    if (!command) {
      return null; // No command to validate
    }

    const result = validateShellCommand(
      command,
      this.allowedCommands,
      (path) => this.scanner.isDeniedPath(path).denied,
    );

    if (!result.valid) {
      return {
        allowed: false,
        reason: `Shell command denied: ${result.reason}`,
        controller: this.name,
      };
    }

    return null; // Allowed — pass through
  }
}

function normalizeAllowedCommands(allowedCommands: string[]): string[] {
  return allowedCommands
    .map((value) => value.trim())
    .filter(Boolean);
}
