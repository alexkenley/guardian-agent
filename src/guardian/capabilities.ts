/**
 * Agent capability system.
 *
 * Defines what actions agents are permitted to perform.
 * Capabilities are granted per-agent in configuration.
 */

/** All known capabilities an agent can be granted. */
export type Capability =
  | 'read_files'
  | 'write_files'
  | 'execute_commands'
  | 'network_access'
  | 'read_email'
  | 'draft_email'
  | 'send_email'
  | 'read_calendar'
  | 'write_calendar'
  | 'read_drive'
  | 'write_drive'
  | 'read_docs'
  | 'write_docs'
  | 'read_sheets'
  | 'write_sheets'
  | 'git_operations'
  | 'install_packages';

/** All valid capability strings. */
export const ALL_CAPABILITIES: readonly Capability[] = [
  'read_files',
  'write_files',
  'execute_commands',
  'network_access',
  'read_email',
  'draft_email',
  'send_email',
  'read_calendar',
  'write_calendar',
  'read_drive',
  'write_drive',
  'read_docs',
  'write_docs',
  'read_sheets',
  'write_sheets',
  'git_operations',
  'install_packages',
];

/** Check if a string is a valid capability. */
export function isValidCapability(value: string): value is Capability {
  return ALL_CAPABILITIES.includes(value as Capability);
}

/** Check if an agent has a specific capability. */
export function hasCapability(
  agentCapabilities: readonly string[],
  required: Capability,
): boolean {
  return agentCapabilities.includes(required);
}

/** Check if an agent has all of the specified capabilities. */
export function hasAllCapabilities(
  agentCapabilities: readonly string[],
  required: readonly Capability[],
): boolean {
  return required.every(cap => agentCapabilities.includes(cap));
}

/** Check if an agent has any of the specified capabilities. */
export function hasAnyCapability(
  agentCapabilities: readonly string[],
  required: readonly Capability[],
): boolean {
  return required.some(cap => agentCapabilities.includes(cap));
}
