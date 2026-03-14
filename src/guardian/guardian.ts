/**
 * Guardian — admission controller pipeline for agent actions.
 *
 * Composable pipeline of controllers that validate and optionally
 * mutate agent actions before they're executed. Protects users
 * from agents (and agents from themselves).
 */

import * as path from 'node:path';
import { hasCapability } from './capabilities.js';
import type { Capability } from './capabilities.js';
import { SecretScanner } from './secret-scanner.js';
import { InputSanitizer } from './input-sanitizer.js';
import type { InputSanitizerConfig } from './input-sanitizer.js';
import { PiiScanner, type PiiEntityType, DEFAULT_VALIDATION_PII_ENTITIES } from './pii-scanner.js';
import { RateLimiter } from './rate-limiter.js';
import type { RateLimiterConfig } from './rate-limiter.js';
import { ShellCommandController } from './shell-command-controller.js';
import { SsrfController } from './ssrf-protection.js';
import type { SsrfConfig } from './ssrf-protection.js';
import { createLogger } from '../util/logging.js';
import { runAdmissionPipeline, sortControllersByPhase } from './workflows.js';
import { handleAdmissionResult } from './operations.js';

const log = createLogger('guardian');

/** An action an agent wants to perform. */
export interface AgentAction {
  /** Action type (e.g., 'write_file', 'execute_command', 'send_message', 'message_dispatch'). */
  type: string;
  /** Agent requesting the action. */
  agentId: string;
  /** Capabilities the agent holds. */
  capabilities: readonly string[];
  /** Action parameters. */
  params: Record<string, unknown>;
}

/** Result of an admission check. */
export interface AdmissionResult {
  /** Whether the action is allowed. */
  allowed: boolean;
  /** Reason for denial (if denied). */
  reason?: string;
  /** Controller that made the decision. */
  controller: string;
  /** Modified action (for mutating controllers). */
  mutatedAction?: AgentAction;
}

/** Phase of the admission pipeline. */
export type AdmissionPhase = 'mutating' | 'validating';

/** An admission controller in the Guardian pipeline. */
export interface AdmissionController {
  /** Controller name for logging. */
  name: string;
  /** Phase: mutating runs first, validating runs second. */
  phase: AdmissionPhase;
  /** Check an action. Return null to pass through. */
  check(action: AgentAction): AdmissionResult | null;
}

/** Built-in: checks agent capabilities against action requirements. */
export class CapabilityController implements AdmissionController {
  readonly name = 'CapabilityController';
  readonly phase: AdmissionPhase = 'validating';

  private actionCapabilityMap: Map<string, Capability>;
  private passthroughActions: Set<string>;

  constructor() {
    this.actionCapabilityMap = new Map([
      ['read_file', 'read_files'],
      ['write_file', 'write_files'],
      ['execute_command', 'execute_commands'],
      ['http_request', 'network_access'],
      ['network_probe', 'network_access'],
      ['mcp_tool', 'network_access'],
      ['system_info', 'execute_commands'],
      ['read_email', 'read_email'],
      ['draft_email', 'draft_email'],
      ['send_email', 'send_email'],
      ['read_calendar', 'read_calendar'],
      ['write_calendar', 'write_calendar'],
      ['read_drive', 'read_drive'],
      ['write_drive', 'write_drive'],
      ['read_docs', 'read_docs'],
      ['write_docs', 'write_docs'],
      ['read_sheets', 'read_sheets'],
      ['write_sheets', 'write_sheets'],
      ['git_operation', 'git_operations'],
      ['install_package', 'install_packages'],
    ]);

    // Actions that are allowed without specific capabilities (internal runtime operations)
    this.passthroughActions = new Set([
      'message_dispatch',
    ]);
  }

  check(action: AgentAction): AdmissionResult | null {
    // Internal runtime actions pass through without capability check
    if (this.passthroughActions.has(action.type)) {
      return null;
    }

    const requiredCap = this.actionCapabilityMap.get(action.type);
    if (!requiredCap) {
      // Default-deny unknown action types
      return {
        allowed: false,
        reason: `Unknown action type '${action.type}' denied by default (no capability mapping)`,
        controller: this.name,
      };
    }

    if (!hasCapability(action.capabilities, requiredCap)) {
      return {
        allowed: false,
        reason: `Agent '${action.agentId}' lacks capability '${requiredCap}' for action '${action.type}'`,
        controller: this.name,
      };
    }

    return null; // Allowed — pass through
  }
}

/** Built-in: scans content for secrets. */
export class SecretScanController implements AdmissionController {
  readonly name = 'SecretScanController';
  readonly phase: AdmissionPhase = 'validating';

  private scanner: SecretScanner;

  constructor(additionalPatterns?: string[]) {
    this.scanner = new SecretScanner(additionalPatterns);
  }

  /**
   * Param field names where email addresses are structurally required.
   * Only these specific fields get the Email Address exemption — email in
   * any other param (e.g. body, notes, description) is still flagged.
   */
  /** @internal Exposed for the helper function `isEmailExemptPath`. */
  static readonly EMAIL_ALLOWED_FIELDS_SET = new Set([
    'params.to', 'params.from', 'params.cc', 'params.bcc',
    'params.sender', 'params.recipient', 'params.recipients',
    'params.attendees', 'params.organizer',
    'params.replyTo', 'params.reply_to',
    'params.content',
    // GWS / native Google tool: email addresses appear in nested json/params structures.
    'params.json.to', 'params.json.from', 'params.json.cc', 'params.json.bcc',
    'params.json.sender', 'params.json.recipient', 'params.json.recipients',
    'params.json.attendees', 'params.json.organizer',
    'params.json.message.raw',           // Gmail: base64-encoded RFC 822 message (contains To/From)
    'params.params.q',                    // Gmail: search query (e.g. "from:user@example.com")
    'params.params.to', 'params.params.from',
  ]);

  /** Action types where the EMAIL_ALLOWED_FIELDS exemption applies. */
  private static readonly EMAIL_FIELD_EXEMPT_ACTIONS = new Set([
    'send_email', 'draft_email', 'read_email',
    'read_calendar', 'write_calendar',
    'message_dispatch',
    'mcp_tool',
  ]);

  check(action: AgentAction): AdmissionResult | null {
    const stringLeaves: Array<{ path: string; value: string }> = [];
    collectStringLeaves(action.params, 'params', stringLeaves);
    const canExemptFields = SecretScanController.EMAIL_FIELD_EXEMPT_ACTIONS.has(action.type);
    for (const leaf of stringLeaves) {
      const secrets = this.scanner.scanContent(leaf.value);
      if (secrets.length > 0) {
        const isAllowedField = canExemptFields && isEmailExemptPath(leaf.path);
        const filtered = isAllowedField
          ? secrets.filter((s) => s.pattern !== 'Email Address')
          : secrets;
        if (filtered.length > 0) {
          const patterns = [...new Set(filtered.map((secret) => secret.pattern))];
          return {
            allowed: false,
            reason: `Secret detected in ${leaf.path}: ${patterns.join(', ')}`,
            controller: this.name,
          };
        }
      }
    }

    return null;
  }
}

/** Built-in: scans content for high-signal PII beyond credential patterns. */
export class PiiScanController implements AdmissionController {
  readonly name = 'PiiScanController';
  readonly phase: AdmissionPhase = 'validating';

  private readonly scanner: PiiScanner;

  constructor(entities?: readonly PiiEntityType[]) {
    const validationEntities = filterValidationPiiEntities(entities);
    this.scanner = new PiiScanner({
      entities: validationEntities.length > 0 ? validationEntities : DEFAULT_VALIDATION_PII_ENTITIES,
      mode: 'redact',
    });
  }

  check(action: AgentAction): AdmissionResult | null {
    // User-authored chat content often includes legitimate PII; redact tool results
    // later rather than blocking the user message itself.
    if (action.type === 'message_dispatch') {
      return null;
    }

    const stringLeaves: Array<{ path: string; value: string }> = [];
    collectStringLeaves(action.params, 'params', stringLeaves);
    for (const leaf of stringLeaves) {
      const matches = this.scanner.scanContent(leaf.value);
      if (matches.length > 0) {
        const patterns = [...new Set(matches.map((match) => match.label))];
        return {
          allowed: false,
          reason: `PII detected in ${leaf.path}: ${patterns.join(', ')}`,
          controller: this.name,
        };
      }
    }

    return null;
  }
}

/** Built-in: blocks access to denied file paths with path normalization. */
export class DeniedPathController implements AdmissionController {
  readonly name = 'DeniedPathController';
  readonly phase: AdmissionPhase = 'validating';

  private scanner: SecretScanner;

  constructor(additionalPatterns?: string[], deniedPaths?: string[]) {
    this.scanner = new SecretScanner(additionalPatterns);
    if (deniedPaths && deniedPaths.length > 0) {
      this.scanner.addDeniedPaths(deniedPaths);
    }
  }

  check(action: AgentAction): AdmissionResult | null {
    const filePath = action.params['path'] as string | undefined;
    if (!filePath) return null;

    // Check for path traversal attempts (Check before normalization)
    if (filePath.includes('..')) {
      return {
        allowed: false,
        reason: `Path traversal detected in '${filePath}'`,
        controller: this.name,
      };
    }

    // Normalize path: convert backslashes to forward slashes for cross-platform,
    const normalized = path.normalize(filePath).replace(/\\/g, '/');

    const result = this.scanner.isDeniedPath(normalized);
    if (result.denied) {
      return {
        allowed: false,
        reason: `Access denied to path '${normalized}': ${result.reason}`,
        controller: this.name,
      };
    }

    return null;
  }
}

/** Options for creating a default Guardian pipeline. */
export interface GuardianCreateOptions {
  logDenials?: boolean;
  additionalSecretPatterns?: string[];
  deniedPaths?: string[];
  inputSanitization?: Partial<InputSanitizerConfig> & { enabled?: boolean };
  piiRedaction?: {
    enabled?: boolean;
    entities?: readonly PiiEntityType[];
  };
  rateLimit?: Partial<RateLimiterConfig>;
  /** Allowed shell commands for ShellCommandController. */
  allowedCommands?: string[];
  /** SSRF protection configuration. */
  ssrf?: Partial<SsrfConfig>;
}

/** Guardian — composable admission controller pipeline. */
export class Guardian {
  private controllers: AdmissionController[] = [];
  private logDenials: boolean;

  constructor(options?: { logDenials?: boolean }) {
    this.logDenials = options?.logDenials ?? true;
  }

  /** Add a controller to the pipeline. */
  use(controller: AdmissionController): this {
    this.controllers.push(controller);
    this.controllers = sortControllersByPhase(this.controllers);
    return this;
  }

  /** Run an action through the admission pipeline. */
  check(action: AgentAction): AdmissionResult {
    const pipelineResult = runAdmissionPipeline(this.controllers, action);
    return handleAdmissionResult(
      pipelineResult,
      action,
      this.logDenials ? log : undefined,
    );
  }

  /** Get all registered controllers. */
  getControllers(): readonly AdmissionController[] {
    return this.controllers;
  }

  /**
   * Update shell command allowlist at runtime.
   *
   * If a ShellCommandController is present, it is updated in place.
   * If missing and commands are provided, one is added.
   * If commands are empty, existing shell command controllers are removed.
   */
  updateShellAllowedCommands(allowedCommands: string[], options?: {
    additionalSecretPatterns?: string[];
    deniedPaths?: string[];
  }): void {
    const normalized = allowedCommands.map((value) => value.trim()).filter(Boolean);
    const existing = this.controllers.filter(
      (controller): controller is ShellCommandController => controller instanceof ShellCommandController,
    );

    if (normalized.length === 0) {
      if (existing.length > 0) {
        this.controllers = this.controllers.filter((controller) => !(controller instanceof ShellCommandController));
      }
      return;
    }

    if (existing.length > 0) {
      for (const controller of existing) {
        controller.updateAllowedCommands(normalized);
      }
      return;
    }

    this.use(new ShellCommandController({
      allowedCommands: normalized,
      additionalSecretPatterns: options?.additionalSecretPatterns,
      deniedPaths: options?.deniedPaths,
    }));
  }

  /**
   * Create a Guardian with all built-in controllers.
   *
   * Pipeline order:
   *   MUTATING:   1. InputSanitizer
   *   VALIDATING: 2. RateLimiter → 3. CapabilityController →
   *               4. SecretScanController → 5. PiiScanController →
   *               6. DeniedPathController → 7. SsrfController
   */
  static createDefault(options?: GuardianCreateOptions): Guardian {
    const guardian = new Guardian({ logDenials: options?.logDenials });

    // Mutating phase
    if (options?.inputSanitization?.enabled !== false) {
      guardian.use(new InputSanitizer(options?.inputSanitization));
    }

    // Validating phase
    if (options?.rateLimit) {
      guardian.use(new RateLimiter(options.rateLimit));
    } else {
      guardian.use(new RateLimiter());
    }
    guardian.use(new CapabilityController());
    guardian.use(new SecretScanController(options?.additionalSecretPatterns));
    if (options?.piiRedaction?.enabled !== false) {
      guardian.use(new PiiScanController(options?.piiRedaction?.entities));
    }
    guardian.use(new DeniedPathController(options?.additionalSecretPatterns, options?.deniedPaths));

    // SSRF protection (enabled by default)
    if (options?.ssrf?.enabled !== false) {
      guardian.use(new SsrfController(options?.ssrf));
    }

    // Shell command validation (if allowed commands provided)
    if (options?.allowedCommands && options.allowedCommands.length > 0) {
      guardian.use(new ShellCommandController({
        allowedCommands: options.allowedCommands,
        additionalSecretPatterns: options?.additionalSecretPatterns,
        deniedPaths: options?.deniedPaths,
      }));
    }

    return guardian;
  }
}

function filterValidationPiiEntities(entities?: readonly PiiEntityType[]): PiiEntityType[] {
  const input = entities ?? DEFAULT_VALIDATION_PII_ENTITIES;
  const allowed = new Set(DEFAULT_VALIDATION_PII_ENTITIES);
  return input.filter((entity): entity is PiiEntityType => allowed.has(entity));
}

/**
 * Check if a leaf path is exempt from Email Address PII detection.
 * Uses exact match for simple fields and prefix match for nested structures
 * (e.g. params.json.attendees.0.email matches prefix "params.json.attendees").
 */
function isEmailExemptPath(path: string): boolean {
  if (SecretScanController.EMAIL_ALLOWED_FIELDS_SET.has(path)) return true;
  // Prefix match: params.json.attendees.0.email starts with "params.json.attendees"
  for (const prefix of SecretScanController.EMAIL_ALLOWED_FIELDS_SET) {
    if (path.startsWith(prefix + '.')) return true;
  }
  return false;
}

function collectStringLeaves(
  value: unknown,
  path: string,
  out: Array<{ path: string; value: string }>,
  seen: Set<unknown> = new Set(),
  depth = 0,
): void {
  if (out.length >= 200 || depth > 8) return;
  if (typeof value === 'string') {
    if (value.length > 0) out.push({ path, value });
    return;
  }
  if (value === null || value === undefined) return;
  if (typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      collectStringLeaves(value[i], `${path}[${i}]`, out, seen, depth + 1);
      if (out.length >= 200) return;
    }
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    collectStringLeaves(nested, `${path}.${key}`, out, seen, depth + 1);
    if (out.length >= 200) return;
  }
}
