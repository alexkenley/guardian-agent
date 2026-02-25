/**
 * Quick action helper for structured personal-assistant requests.
 */

import type { AssistantQuickActionsConfig } from './config/types.js';

export interface QuickActionDefinition {
  id: string;
  label: string;
  description: string;
  detailsHint: string;
}

export interface QuickActionResult {
  actionId: string;
  prompt: string;
}

const BUILTIN_ACTIONS: QuickActionDefinition[] = [
  {
    id: 'email',
    label: 'Draft Email',
    description: 'Generate a complete email draft with subject and body.',
    detailsHint: 'Who it is for, purpose, tone, key points, deadline',
  },
  {
    id: 'task',
    label: 'Plan Tasks',
    description: 'Turn a goal into a prioritized actionable task plan.',
    detailsHint: 'Goal, constraints, due date, dependencies',
  },
  {
    id: 'calendar',
    label: 'Plan Meeting',
    description: 'Create a calendar-ready meeting outline and agenda.',
    detailsHint: 'Objective, attendees, duration, preferred times',
  },
];

export function getQuickActions(config: AssistantQuickActionsConfig): QuickActionDefinition[] {
  if (!config.enabled) return [];
  return BUILTIN_ACTIONS;
}

export function buildQuickActionPrompt(
  config: AssistantQuickActionsConfig,
  actionId: string,
  details: string,
): QuickActionResult | null {
  if (!config.enabled) return null;

  const template = config.templates[actionId];
  if (!template) return null;

  const trimmed = details.trim();
  const prompt = template.replaceAll('{details}', trimmed || 'No details provided.');
  return { actionId, prompt };
}
