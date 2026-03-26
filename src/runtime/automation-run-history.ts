import type { AutomationOutputHandlingConfig } from '../config/types.js';
import type { PlaybookRunRecord } from './connectors.js';
import type { ScheduledTaskHistoryEntry } from './scheduled-tasks.js';

export interface AutomationRunHistoryEntry {
  id: string;
  time: number;
  name: string;
  source: string;
  status: string;
  duration: number;
  message?: string;
  steps: Array<Record<string, unknown>>;
  outputHandling?: AutomationOutputHandlingConfig;
  promotedFindings: Array<Record<string, unknown>>;
}

export function buildAutomationRunHistoryEntries(
  playbookRuns: PlaybookRunRecord[],
  taskHistory: ScheduledTaskHistoryEntry[],
): AutomationRunHistoryEntry[] {
  const merged: AutomationRunHistoryEntry[] = [];

  for (const run of playbookRuns) {
    merged.push({
      id: run.id,
      time: run.startedAt || run.createdAt || 0,
      name: run.playbookName || run.playbookId || '',
      source: 'automation',
      status: run.status || '',
      duration: run.durationMs || 0,
      ...(run.message ? { message: run.message } : {}),
      steps: run.steps.map((step) => ({ ...step })),
      ...(run.outputHandling ? { outputHandling: { ...run.outputHandling } } : {}),
      promotedFindings: (run.promotedFindings ?? []).map((finding) => ({ ...finding })),
    });
  }

  for (const item of taskHistory) {
    merged.push({
      id: item.id || `${item.taskId || 'task'}-${item.timestamp || 0}`,
      time: item.timestamp || 0,
      name: item.taskName || '',
      source: item.taskType === 'playbook'
        ? 'scheduled automation'
        : item.taskType === 'agent'
          ? 'scheduled assistant'
          : 'scheduled',
      status: item.status || '',
      duration: item.durationMs || 0,
      ...(item.message ? { message: item.message } : {}),
      steps: (item.steps ?? []).map((step) => ({ ...step })),
      ...(item.outputHandling ? { outputHandling: { ...item.outputHandling } } : {}),
      promotedFindings: (item.promotedFindings ?? []).map((finding) => ({ ...finding })),
    });
  }

  return merged
    .sort((left, right) => right.time - left.time)
    .slice(0, 60);
}
