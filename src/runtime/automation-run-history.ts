import type { AutomationOutputHandlingConfig } from '../config/types.js';
import type { PlaybookRunRecord } from './connectors.js';
import type { ScheduledTaskHistoryEntry } from './scheduled-tasks.js';
import type {
  AutomationMemoryPromotionStatus,
  AutomationStoredOutputStatus,
} from './automation-output-persistence.js';
import type {
  AutomationOutputStore,
  AutomationOutputStoreManifest,
} from './automation-output-store.js';

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
  storedOutput?: AutomationStoredOutputStatus;
  memoryPromotion?: AutomationMemoryPromotionStatus;
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
      ...(run.storedOutput
        ? {
            storedOutput: {
              ...run.storedOutput,
              ...(run.storedOutput.taintReasons ? { taintReasons: [...run.storedOutput.taintReasons] } : {}),
            },
          }
        : {}),
      ...(run.memoryPromotion ? { memoryPromotion: { ...run.memoryPromotion } } : {}),
    });
  }

  for (const item of taskHistory) {
    merged.push({
      id: item.runId || item.id || `${item.taskId || 'task'}-${item.timestamp || 0}`,
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
      ...(item.storedOutput
        ? {
            storedOutput: {
              ...item.storedOutput,
              ...(item.storedOutput.taintReasons ? { taintReasons: [...item.storedOutput.taintReasons] } : {}),
            },
          }
        : {}),
      ...(item.memoryPromotion ? { memoryPromotion: { ...item.memoryPromotion } } : {}),
    });
  }

  return merged
    .sort((left, right) => right.time - left.time)
    .slice(0, 60);
}

export function buildPersistedAutomationRunHistoryEntries(
  manifests: AutomationOutputStoreManifest[],
  outputStore: AutomationOutputStore,
): AutomationRunHistoryEntry[] {
  return manifests.map((manifest) => {
    const steps = manifest.steps.map((step) => {
      const read = outputStore.read({
        runId: manifest.runId,
        stepId: step.stepId,
        maxChars: 60_000,
      });
      return {
        stepId: step.stepId,
        toolName: step.toolName,
        status: step.status,
        message: step.message || step.preview,
        durationMs: 0,
        ...(read?.text ? { output: parseStoredStepOutput(step.contentType, read.text) } : {}),
      };
    });

    return {
      id: manifest.runId,
      time: manifest.completedAt || manifest.storedAt,
      name: manifest.automationName,
      source: manifest.origin === 'schedule' ? 'scheduled automation' : 'automation',
      status: manifest.status,
      duration: computeDurationMs(manifest),
      message: manifest.message || manifest.summary,
      steps,
      outputHandling: {
        notify: 'off',
        sendToSecurity: 'off',
        persistArtifacts: 'run_history_plus_memory',
      },
      promotedFindings: [],
      storedOutput: {
        status: 'saved',
        runId: manifest.runId,
        storeId: manifest.storeId,
        runLink: manifest.runLink,
        stepCount: manifest.steps.length,
        trustLevel: manifest.trustLevel,
        taintReasons: [...manifest.taintReasons],
      },
      ...(manifest.memoryPromotion ? { memoryPromotion: { ...manifest.memoryPromotion } } : {}),
    };
  });
}

function computeDurationMs(manifest: AutomationOutputStoreManifest): number {
  if (Number.isFinite(manifest.startedAt) && Number.isFinite(manifest.completedAt)) {
    return Math.max(0, Number(manifest.completedAt) - Number(manifest.startedAt));
  }
  return 0;
}

function parseStoredStepOutput(contentType: string, text: string): unknown {
  if (contentType !== 'json') return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
