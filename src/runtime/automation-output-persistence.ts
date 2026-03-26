import type { ContentTrustLevel } from '../tools/types.js';
import type { AgentMemoryStore } from './agent-memory-store.js';
import {
  normalizeAutomationOutputHandling,
  type AutomationPromotionInput,
} from './automation-output.js';
import {
  AutomationOutputStore,
  type AutomationOutputStoreInput,
  type AutomationStoredOutputRef,
} from './automation-output-store.js';

export interface AutomationStoredOutputStatus {
  status: 'saved' | 'failed' | 'skipped';
  runId?: string;
  storeId?: string;
  runLink?: string;
  stepCount?: number;
  trustLevel?: ContentTrustLevel;
  taintReasons?: string[];
  reason?: string;
}

export interface AutomationMemoryPromotionStatus {
  status: 'saved' | 'blocked' | 'failed' | 'skipped';
  agentId?: string;
  entryId?: string;
  reason?: string;
}

export interface AutomationOutputPersistenceResult {
  storedOutput: AutomationStoredOutputStatus;
  memoryPromotion: AutomationMemoryPromotionStatus;
}

export interface AutomationOutputPersistenceInput extends AutomationPromotionInput {
  startedAt?: number;
  completedAt?: number;
  memoryAgentId?: string;
}

export interface AutomationOutputPersistenceServiceOptions {
  outputStore: AutomationOutputStore;
  agentMemoryStore?: AgentMemoryStore;
  defaultAgentId?: string;
  now?: () => number;
}

export class AutomationOutputPersistenceService {
  private readonly outputStore: AutomationOutputStore;
  private readonly agentMemoryStore?: AgentMemoryStore;
  private readonly defaultAgentId: string;
  private readonly now: () => number;

  constructor(options: AutomationOutputPersistenceServiceOptions) {
    this.outputStore = options.outputStore;
    this.agentMemoryStore = options.agentMemoryStore;
    this.defaultAgentId = options.defaultAgentId?.trim() || 'default';
    this.now = options.now ?? Date.now;
  }

  persistRun(input: AutomationOutputPersistenceInput): AutomationOutputPersistenceResult {
    const outputHandling = normalizeAutomationOutputHandling(input.outputHandling);
    if (outputHandling.persistArtifacts !== 'run_history_plus_memory') {
      return {
        storedOutput: {
          status: 'skipped',
          runId: input.runId,
          runLink: input.runLink,
          reason: 'Historical output persistence is disabled for this automation.',
        },
        memoryPromotion: {
          status: 'skipped',
          reason: 'Historical output persistence is disabled for this automation.',
        },
      };
    }

    let storedRef: AutomationStoredOutputRef;
    try {
      storedRef = this.outputStore.saveRun(toStoredOutputInput(input));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        storedOutput: {
          status: 'failed',
          runId: input.runId,
          runLink: input.runLink,
          reason,
        },
        memoryPromotion: {
          status: 'skipped',
          reason: 'Full output could not be stored, so no memory reference was written.',
        },
      };
    }

    const storedOutput: AutomationStoredOutputStatus = {
      status: 'saved',
      runId: storedRef.runId,
      storeId: storedRef.storeId,
      runLink: storedRef.runLink,
      stepCount: storedRef.stepCount,
      trustLevel: storedRef.trustLevel,
      taintReasons: [...storedRef.taintReasons],
    };

    if (!this.agentMemoryStore) {
      this.outputStore.setMemoryPromotion(storedRef.runId, {
        status: 'blocked',
        reason: 'Agent memory store is not available.',
      });
      return {
        storedOutput,
        memoryPromotion: {
          status: 'blocked',
          reason: 'Agent memory store is not available.',
        },
      };
    }

    if (typeof this.agentMemoryStore.isEnabled === 'function' && !this.agentMemoryStore.isEnabled()) {
      this.outputStore.setMemoryPromotion(storedRef.runId, {
        status: 'blocked',
        reason: 'Agent memory is disabled.',
      });
      return {
        storedOutput,
        memoryPromotion: {
          status: 'blocked',
          reason: 'Agent memory is disabled.',
        },
      };
    }

    if (this.agentMemoryStore.isReadOnly()) {
      this.outputStore.setMemoryPromotion(storedRef.runId, {
        status: 'blocked',
        reason: 'Agent memory is read-only.',
      });
      return {
        storedOutput,
        memoryPromotion: {
          status: 'blocked',
          reason: 'Agent memory is read-only.',
        },
      };
    }

    const memoryAgentId = resolveMemoryAgentId(input.memoryAgentId, input.agentId, this.defaultAgentId);
    const timestamp = new Date(input.completedAt ?? this.now());
    try {
      const stored = this.agentMemoryStore.append(memoryAgentId, {
        content: buildReferenceContent(input, storedRef, timestamp),
        summary: buildReferenceSummary(input),
        createdAt: timestamp.toISOString().slice(0, 10),
        category: 'Automation Results',
        sourceType: 'system',
        trustLevel: 'trusted',
        status: 'active',
        createdByPrincipal: 'system:automation_output',
        tags: buildReferenceTags(input, storedRef),
        provenance: {
          toolName: 'automation_output_read',
          domain: 'automation',
          requestId: input.runId,
          taintReasons: storedRef.taintReasons.length > 0 ? [...storedRef.taintReasons] : undefined,
        },
      });
      this.outputStore.setMemoryPromotion(storedRef.runId, {
        status: 'saved',
        agentId: memoryAgentId,
        entryId: stored.id,
      });
      return {
        storedOutput,
        memoryPromotion: {
          status: 'saved',
          agentId: memoryAgentId,
          entryId: stored.id,
        },
      };
    } catch (err) {
      this.outputStore.setMemoryPromotion(storedRef.runId, {
        status: 'failed',
        agentId: memoryAgentId,
        reason: err instanceof Error ? err.message : String(err),
      });
      return {
        storedOutput,
        memoryPromotion: {
          status: 'failed',
          agentId: memoryAgentId,
          reason: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
}

function toStoredOutputInput(input: AutomationOutputPersistenceInput): AutomationOutputStoreInput {
  return {
    automationId: input.automationId,
    automationName: input.automationName,
    runId: input.runId,
    status: input.status,
    message: input.message,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    origin: input.origin,
    agentId: input.agentId,
    userId: input.userId,
    channel: input.channel,
    target: input.target,
    taskId: input.taskId,
    runLink: input.runLink,
    steps: Array.isArray(input.steps) ? input.steps.map((step) => ({ ...step })) : [],
  };
}

function resolveMemoryAgentId(
  explicitAgentId: string | undefined,
  runAgentId: string | undefined,
  defaultAgentId: string,
): string {
  const explicit = explicitAgentId?.trim();
  if (explicit) return explicit;
  const runtimeAgentId = runAgentId?.trim();
  if (runtimeAgentId && !runtimeAgentId.startsWith('sched-task:')) return runtimeAgentId;
  return defaultAgentId;
}

function buildReferenceSummary(
  input: AutomationOutputPersistenceInput,
): string {
  return `Automation result reference: ${input.automationName.trim() || input.automationId} (${normalizeText(input.status) || 'completed'})`;
}

function buildReferenceContent(
  input: AutomationOutputPersistenceInput,
  storedRef: AutomationStoredOutputRef,
  completedAt: Date,
): string {
  const toolNames = uniqueStrings((input.steps ?? []).map((step) => normalizeText(step.toolName))).slice(0, 8);
  const lines = [
    'Automation result reference',
    `Automation: ${input.automationName.trim() || input.automationId}`,
    `Automation ID: ${input.automationId}`,
    `Run ID: ${input.runId}`,
    `Status: ${normalizeText(input.status) || 'completed'}`,
    `Stored Output ID: ${storedRef.storeId}`,
    `Stored At: ${completedAt.toISOString()}`,
    `Recorded Steps: ${storedRef.stepCount}`,
    `Historical Analysis: Full stored output is available through automation_output_search and automation_output_read.`,
    `Run Link: ${storedRef.runLink}`,
  ];
  if (toolNames.length > 0) {
    lines.push(`Tools: ${toolNames.join(', ')}`);
  }
  if (storedRef.taintReasons.length > 0) {
    lines.push(`Underlying Output Trust: ${storedRef.trustLevel} (${storedRef.taintReasons.join(', ')})`);
  } else {
    lines.push(`Underlying Output Trust: ${storedRef.trustLevel}`);
  }
  return lines.join('\n');
}

function buildReferenceTags(
  input: AutomationOutputPersistenceInput,
  storedRef: AutomationStoredOutputRef,
): string[] {
  return uniqueStrings([
    'automation',
    'automation-output',
    `automation:${input.automationId}`,
    `run:${normalizeText(input.status) || 'completed'}`,
    ...((input.steps ?? []).slice(0, 6).map((step) => `tool:${normalizeText(step.toolName)}`).filter(Boolean)),
    ...(storedRef.taintReasons.length > 0 ? ['underlying:low-trust'] : []),
  ]);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
