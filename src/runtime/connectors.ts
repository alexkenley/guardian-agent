/**
 * Connector + Playbook runtime service (Option 2).
 *
 * Executes declarative playbooks through the existing ToolExecutor pipeline so
 * Guardian checks, tool policy, and approvals remain the enforcement boundary.
 */

import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import type {
  AssistantConnectorsConfig,
  AssistantConnectorPackConfig,
  AssistantConnectorPlaybookDefinition,
  AssistantConnectorPlaybookStepDefinition,
  AutomationOutputHandlingConfig,
  ConnectorExecutionMode,
} from '../config/types.js';
import type { ToolExecutionRequest, ToolRunResponse } from '../tools/types.js';
import type { ToolApprovalDecisionResult } from '../tools/executor.js';
import type { AutomationPromotedFindingRef } from './automation-output.js';
import type {
  AutomationMemoryPromotionStatus,
  AutomationStoredOutputStatus,
} from './automation-output-persistence.js';
import { GraphRunner } from './graph-runner.js';
import type { GraphNodeExecutionResult, PlaybookGraphDefinition } from './graph-types.js';
import { createRunEvent, type OrchestrationRunEvent } from './run-events.js';
import { InMemoryRunStateStore, type RunStateStore } from './run-state-store.js';

const MAX_RUN_HISTORY = 200;

type PlaybookStepStatus = 'succeeded' | 'failed' | 'pending_approval' | 'denied';
type PlaybookRunStatus = 'succeeded' | 'failed' | 'awaiting_approval';

export interface PlaybookCitation {
  title: string;
  url: string;
  snippet?: string;
  sourceStepId?: string;
}

export interface PlaybookEvidenceItem {
  kind: 'search_result' | 'citation' | 'page_excerpt' | 'structured_output';
  summary: string;
  url?: string;
  sourceStepId?: string;
}

export interface PlaybookStepRunResult {
  stepId: string;
  toolName: string;
  packId: string;
  status: PlaybookStepStatus;
  message: string;
  jobId?: string;
  approvalId?: string;
  durationMs: number;
  output?: unknown;
  citations?: PlaybookCitation[];
  evidence?: PlaybookEvidenceItem[];
}

export interface PlaybookRunRecord {
  id: string;
  runId: string;
  graphId: string;
  playbookId: string;
  playbookName: string;
  createdAt: number;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  dryRun: boolean;
  status: PlaybookRunStatus;
  message: string;
  steps: PlaybookStepRunResult[];
  outputHandling?: AutomationOutputHandlingConfig;
  promotedFindings?: AutomationPromotedFindingRef[];
  storedOutput?: AutomationStoredOutputStatus;
  memoryPromotion?: AutomationMemoryPromotionStatus;
  requestedBy?: string;
  origin: ToolExecutionRequest['origin'];
  events: OrchestrationRunEvent[];
}

export interface ConnectorFrameworkState {
  summary: {
    enabled: boolean;
    executionMode: ConnectorExecutionMode;
    maxConnectorCallsPerRun: number;
    packCount: number;
    enabledPackCount: number;
    playbookCount: number;
    enabledPlaybookCount: number;
    runCount: number;
    dryRunQualifiedCount: number;
  };
  packs: AssistantConnectorPackConfig[];
  playbooks: AssistantConnectorPlaybookDefinition[];
  runs: PlaybookRunRecord[];
  playbooksConfig: {
    enabled: boolean;
    maxSteps: number;
    maxParallelSteps: number;
    defaultStepTimeoutMs: number;
    requireSignedDefinitions: boolean;
    requireDryRunOnFirstExecution: boolean;
  };
  studio: AssistantConnectorsConfig['studio'];
}

export interface ConnectorSettingsUpdate {
  enabled?: boolean;
  executionMode?: ConnectorExecutionMode;
  maxConnectorCallsPerRun?: number;
  playbooks?: Partial<AssistantConnectorsConfig['playbooks']>;
  studio?: Partial<AssistantConnectorsConfig['studio']>;
}

export interface ConnectorPlaybookRunInput {
  playbookId: string;
  dryRun?: boolean;
  origin: ToolExecutionRequest['origin'];
  agentId?: string;
  userId?: string;
  channel?: string;
  requestedBy?: string;
  bypassApprovals?: boolean;
}

export interface ConnectorPlaybookRunResult {
  success: boolean;
  status: PlaybookRunStatus;
  message: string;
  run: PlaybookRunRecord;
}

/** Callback that sends a prompt to an LLM and returns the text response. */
export type RunInstructionFn = (
  prompt: string,
  provider?: string,
  maxTokens?: number,
) => Promise<string>;

interface PlaybookResumeContext {
  playbookId: string;
  dryRun: boolean;
  origin: ToolExecutionRequest['origin'];
  agentId?: string;
  userId?: string;
  channel?: string;
  requestedBy?: string;
  bypassApprovals?: boolean;
}

interface ConnectorPlaybookServiceOptions {
  config: AssistantConnectorsConfig;
  runTool: (request: ToolExecutionRequest) => Promise<ToolRunResponse>;
  /** Optional LLM callback for instruction steps. Required if playbooks use instruction steps. */
  runInstruction?: RunInstructionFn;
  /** Optional output scanner (e.g. OutputGuardian) for instruction step responses. */
  scanOutput?: (text: string) => Promise<string>;
  now?: () => number;
  runStateStore?: RunStateStore<PlaybookStepRunResult>;
  onRunRecorded?: (run: PlaybookRunRecord, input: ConnectorPlaybookRunInput) => Promise<void> | void;
}

export class ConnectorPlaybookService {
  private config: AssistantConnectorsConfig;
  private readonly runTool: (request: ToolExecutionRequest) => Promise<ToolRunResponse>;
  private readonly runInstruction?: RunInstructionFn;
  private readonly scanOutput?: (text: string) => Promise<string>;
  private readonly now: () => number;
  private readonly onRunRecorded?: ConnectorPlaybookServiceOptions['onRunRecorded'];
  private readonly graphRunner: GraphRunner<PlaybookStepRunResult>;
  private readonly runs: PlaybookRunRecord[] = [];
  private readonly dryRunQualified = new Set<string>();

  constructor(options: ConnectorPlaybookServiceOptions) {
    this.config = cloneConnectorsConfig(options.config);
    this.runTool = options.runTool;
    this.runInstruction = options.runInstruction;
    this.scanOutput = options.scanOutput;
    this.now = options.now ?? Date.now;
    this.onRunRecorded = options.onRunRecorded;
    this.graphRunner = new GraphRunner<PlaybookStepRunResult>({
      now: this.now,
      store: options.runStateStore ?? new InMemoryRunStateStore<PlaybookStepRunResult>(),
    });
  }

  getConfig(): AssistantConnectorsConfig {
    return cloneConnectorsConfig(this.config);
  }

  updateConfig(config: AssistantConnectorsConfig): void {
    this.config = cloneConnectorsConfig(config);
  }

  getState(limitRuns = 50): ConnectorFrameworkState {
    const packs = this.config.packs.map(clonePack);
    const playbooks = this.config.playbooks.definitions.map(clonePlaybook);
    return {
      summary: {
        enabled: this.config.enabled,
        executionMode: this.config.executionMode,
        maxConnectorCallsPerRun: this.config.maxConnectorCallsPerRun,
        packCount: packs.length,
        enabledPackCount: packs.filter((pack) => pack.enabled).length,
        playbookCount: playbooks.length,
        enabledPlaybookCount: playbooks.filter((playbook) => playbook.enabled).length,
        runCount: this.runs.length,
        dryRunQualifiedCount: this.dryRunQualified.size,
      },
      packs,
      playbooks,
      runs: this.runs.slice(0, Math.max(1, limitRuns)).map((run) => ({
        ...run,
        steps: run.steps.map((step) => ({
          ...step,
          citations: step.citations ? step.citations.map((citation) => ({ ...citation })) : undefined,
          evidence: step.evidence ? step.evidence.map((item) => ({ ...item })) : undefined,
        })),
        events: run.events.map((event) => ({ ...event })),
      })),
      playbooksConfig: {
        enabled: this.config.playbooks.enabled,
        maxSteps: this.config.playbooks.maxSteps,
        maxParallelSteps: this.config.playbooks.maxParallelSteps,
        defaultStepTimeoutMs: this.config.playbooks.defaultStepTimeoutMs,
        requireSignedDefinitions: this.config.playbooks.requireSignedDefinitions,
        requireDryRunOnFirstExecution: this.config.playbooks.requireDryRunOnFirstExecution,
      },
      studio: { ...this.config.studio },
    };
  }

  updateSettings(update: ConnectorSettingsUpdate): { success: boolean; message: string } {
    if (update.enabled !== undefined) {
      this.config.enabled = update.enabled;
    }
    if (update.executionMode) {
      this.config.executionMode = update.executionMode;
    }
    if (update.maxConnectorCallsPerRun !== undefined) {
      this.config.maxConnectorCallsPerRun = update.maxConnectorCallsPerRun;
    }
    if (update.playbooks) {
      this.config.playbooks = {
        ...this.config.playbooks,
        ...update.playbooks,
      };
    }
    if (update.studio) {
      this.config.studio = {
        ...this.config.studio,
        ...update.studio,
      };
    }
    return { success: true, message: 'Connector settings updated.' };
  }

  upsertPack(pack: AssistantConnectorPackConfig): { success: boolean; message: string } {
    const index = this.config.packs.findIndex((existing) => existing.id === pack.id);
    if (index >= 0) {
      this.config.packs[index] = clonePack(pack);
      return { success: true, message: `Updated connector pack '${pack.id}'.` };
    }
    this.config.packs.push(clonePack(pack));
    return { success: true, message: `Added connector pack '${pack.id}'.` };
  }

  deletePack(packId: string): { success: boolean; message: string } {
    const index = this.config.packs.findIndex((pack) => pack.id === packId);
    if (index < 0) {
      return { success: false, message: `Connector pack '${packId}' not found.` };
    }
    this.config.packs.splice(index, 1);
    return { success: true, message: `Deleted connector pack '${packId}'.` };
  }

  upsertPlaybook(playbook: AssistantConnectorPlaybookDefinition): { success: boolean; message: string } {
    const index = this.config.playbooks.definitions.findIndex((existing) => existing.id === playbook.id);
    if (index >= 0) {
      this.config.playbooks.definitions[index] = clonePlaybook(playbook);
      return { success: true, message: `Updated automation '${describeAutomation(playbook)}'.` };
    }
    this.config.playbooks.definitions.push(clonePlaybook(playbook));
    return { success: true, message: `Added automation '${describeAutomation(playbook)}'.` };
  }

  deletePlaybook(playbookId: string): { success: boolean; message: string } {
    const index = this.config.playbooks.definitions.findIndex((playbook) => playbook.id === playbookId);
    if (index < 0) {
      return { success: false, message: `Automation '${playbookId}' was not found.` };
    }
    this.config.playbooks.definitions.splice(index, 1);
    this.dryRunQualified.delete(playbookId);
    return { success: true, message: `Deleted automation '${playbookId}'.` };
  }

  private buildGraphHandlers(
    playbook: AssistantConnectorPlaybookDefinition,
    input: ConnectorPlaybookRunInput,
  ): {
    executeStep: (node: Extract<import('./graph-types.js').PlaybookGraphNode, { type: 'step' }>, priorResults: PlaybookStepRunResult[]) => Promise<GraphNodeExecutionResult<PlaybookStepRunResult>>;
    executeParallel: (node: Extract<import('./graph-types.js').PlaybookGraphNode, { type: 'parallel' }>, priorResults: PlaybookStepRunResult[]) => Promise<GraphNodeExecutionResult<PlaybookStepRunResult>>;
  } {
    return {
      executeStep: async (node, priorResults) => {
        const result = await this.executeStep(node.step, input, priorResults);
        return {
          status: result.status === 'denied' ? 'failed' : result.status,
          results: [result],
          message: result.message,
        } satisfies GraphNodeExecutionResult<PlaybookStepRunResult>;
      },
      executeParallel: async (node, priorResults) => {
        const results = await Promise.all(node.steps.map((step) => this.executeStep(step, input, priorResults)));
        const hasPending = results.some((result) => result.status === 'pending_approval');
        const hasHardFailure = results.some((result) => {
          if (result.status !== 'failed' && result.status !== 'denied') return false;
          const def = node.steps.find((item) => item.id === result.stepId);
          return !def?.continueOnError;
        });
        return {
          status: hasPending ? 'pending_approval' : hasHardFailure ? 'failed' : 'succeeded',
          results,
          message: hasPending
            ? `Automation '${describeAutomation(playbook)}' paused for approval.`
            : hasHardFailure
              ? `Automation '${describeAutomation(playbook)}' completed with failures.`
              : `Automation '${describeAutomation(playbook)}' completed successfully.`,
        } satisfies GraphNodeExecutionResult<PlaybookStepRunResult>;
      },
    };
  }

  private upsertRun(run: PlaybookRunRecord): void {
    const existingIndex = this.runs.findIndex((entry) => entry.runId === run.runId);
    if (existingIndex >= 0) {
      this.runs.splice(existingIndex, 1);
    }
    this.runs.unshift(run);
    if (this.runs.length > MAX_RUN_HISTORY) {
      this.runs.length = MAX_RUN_HISTORY;
    }
  }

  private buildRunRecord(
    playbook: AssistantConnectorPlaybookDefinition,
    input: ConnectorPlaybookRunInput,
    graphResult: Awaited<ReturnType<GraphRunner<PlaybookStepRunResult>['run']>>,
    startedAt: number,
    existingRunId?: string,
  ): PlaybookRunRecord {
    const status: PlaybookRunStatus = graphResult.status === 'awaiting_approval'
      ? 'awaiting_approval'
      : graphResult.status === 'failed'
        ? 'failed'
        : 'succeeded';

    const completedAt = this.now();
    return {
      id: existingRunId ?? randomUUID(),
      runId: graphResult.runId,
      graphId: graphResult.graphId,
      playbookId: playbook.id,
      playbookName: playbook.name,
      createdAt: startedAt,
      startedAt,
      completedAt,
      durationMs: completedAt - startedAt,
      dryRun: !!input.dryRun,
      status,
      message: graphResult.message,
      steps: graphResult.results.map((step) => ({
        ...step,
        citations: step.citations ? step.citations.map((citation) => ({ ...citation })) : undefined,
        evidence: step.evidence ? step.evidence.map((item) => ({ ...item })) : undefined,
      })),
      outputHandling: playbook.outputHandling,
      requestedBy: input.requestedBy,
      origin: input.origin,
      events: graphResult.events.map((event) => ({ ...event })),
    };
  }

  async runPlaybook(input: ConnectorPlaybookRunInput): Promise<ConnectorPlaybookRunResult> {
    const playbook = this.config.playbooks.definitions.find((candidate) => candidate.id === input.playbookId);
    if (!this.config.enabled) {
      return this.buildDeniedRun(input, playbook, 'Connector framework is disabled.');
    }
    if (!this.config.playbooks.enabled) {
      return this.buildDeniedRun(input, playbook, 'Automation execution is disabled.');
    }
    if (!playbook) {
      return this.buildDeniedRun(input, undefined, `Automation '${input.playbookId}' was not found.`);
    }
    if (!playbook.enabled) {
      return this.buildDeniedRun(input, playbook, `Automation '${describeAutomation(playbook)}' is disabled.`);
    }
    if (this.config.playbooks.requireSignedDefinitions && !playbook.signature?.trim()) {
      return this.buildDeniedRun(input, playbook, `Automation '${describeAutomation(playbook)}' requires a signature.`);
    }
    if (
      this.config.playbooks.requireDryRunOnFirstExecution &&
      !input.dryRun &&
      !this.dryRunQualified.has(playbook.id)
    ) {
      return this.buildDeniedRun(
        input,
        playbook,
        `Automation '${describeAutomation(playbook)}' requires a successful dry run before live execution.`,
      );
    }

    if (playbook.steps.length > this.config.playbooks.maxSteps) {
      return this.buildDeniedRun(
        input,
        playbook,
        `Automation '${describeAutomation(playbook)}' exceeds configured max steps (${this.config.playbooks.maxSteps}).`,
      );
    }
    if (playbook.steps.length > this.config.maxConnectorCallsPerRun) {
      return this.buildDeniedRun(
        input,
        playbook,
        `Automation '${describeAutomation(playbook)}' exceeds max connector calls per run (${this.config.maxConnectorCallsPerRun}).`,
      );
    }

    const startedAt = this.now();
    const graph = compilePlaybookToGraph(playbook);
    const graphResult = await this.graphRunner.run(graph, this.buildGraphHandlers(playbook, input), {
      resumeContext: {
        playbookId: input.playbookId,
        dryRun: !!input.dryRun,
        origin: input.origin,
        agentId: input.agentId,
        userId: input.userId,
        channel: input.channel,
        requestedBy: input.requestedBy,
        bypassApprovals: input.bypassApprovals === true,
      } satisfies PlaybookResumeContext,
    });

    const run = this.buildRunRecord(playbook, input, graphResult, startedAt);
    this.upsertRun(run);
    await this.onRunRecorded?.(run, input);

    if (input.dryRun && run.status === 'succeeded') {
      this.dryRunQualified.add(playbook.id);
    }

    return {
      success: run.status === 'succeeded',
      status: run.status,
      message: run.message,
      run,
    };
  }

  async continueAfterApprovalDecision(
    approvalId: string,
    decision: 'approved' | 'denied',
    decisionResult: ToolApprovalDecisionResult,
  ): Promise<ConnectorPlaybookRunResult | null> {
    const normalizedApprovalId = approvalId.trim();
    if (!normalizedApprovalId) return null;

    const checkpoint = this.graphRunner.getStore()
      .list(MAX_RUN_HISTORY)
      .find((entry) => entry.pendingApprovalIds?.includes(normalizedApprovalId));
    if (!checkpoint) {
      return null;
    }

    const resumeContext = parseResumeContext(checkpoint.resumeContext);
    if (!resumeContext) {
      return null;
    }

    const playbook = this.config.playbooks.definitions.find((candidate) => candidate.id === resumeContext.playbookId);
    if (!playbook) {
      return null;
    }

    const graph = compilePlaybookToGraph(playbook);
    const liveCheckpoint = this.graphRunner.getStore().get(checkpoint.runId);
    if (!liveCheckpoint) {
      return null;
    }

    const updatedResults = liveCheckpoint.results.map((step) => {
      if (step.approvalId !== normalizedApprovalId) {
        return step;
      }
      if (decision === 'denied') {
        return {
          ...step,
          status: 'denied' as const,
          message: decisionResult.message,
          citations: step.citations ? step.citations.map((citation) => ({ ...citation })) : undefined,
          evidence: step.evidence ? step.evidence.map((item) => ({ ...item })) : undefined,
        };
      }
      return {
        ...step,
        status: decisionResult.result?.success ? 'succeeded' as const : 'failed' as const,
        message: decisionResult.message,
        jobId: decisionResult.result?.jobId ?? step.jobId,
        durationMs: decisionResult.job?.durationMs ?? step.durationMs,
        output: decisionResult.result?.output ?? step.output,
        citations: extractEvidenceBundle(decisionResult.result?.output, step.stepId).citations,
        evidence: extractEvidenceBundle(decisionResult.result?.output, step.stepId).evidence,
      };
    });
    const remainingApprovalIds = (liveCheckpoint.pendingApprovalIds ?? []).filter((id) => id !== normalizedApprovalId);
    const nextEvents = liveCheckpoint.events.map((event) => ({ ...event }));

    if (decision === 'denied') {
      nextEvents.push(createRunEvent(liveCheckpoint.runId, 'approval_denied', this.now(), {
        nodeId: liveCheckpoint.currentNodeId,
        message: `Approval '${normalizedApprovalId}' was denied.`,
        metadata: { approvalId: normalizedApprovalId },
      }));
    }

    const updatedCheckpoint = {
      ...liveCheckpoint,
      results: updatedResults,
      pendingApprovalIds: remainingApprovalIds,
      events: nextEvents,
      status: remainingApprovalIds.length === 0 ? 'running' as const : 'awaiting_approval' as const,
    };
    this.graphRunner.getStore().save(updatedCheckpoint);

    if (remainingApprovalIds.length > 0) {
      const existingRun = this.runs.find((run) => run.runId === liveCheckpoint.runId);
      const run = this.buildRunRecord(
        playbook,
        toRunInput(resumeContext),
        {
          runId: liveCheckpoint.runId,
          graphId: liveCheckpoint.graphId,
          graphName: liveCheckpoint.graphName,
          status: 'awaiting_approval',
          message: `Automation '${describeAutomation(playbook)}' is still awaiting additional approvals.`,
          results: updatedResults,
          events: nextEvents,
          checkpoint: updatedCheckpoint,
        },
        existingRun?.startedAt ?? liveCheckpoint.createdAt,
        existingRun?.id,
      );
      this.upsertRun(run);
      return {
        success: false,
        status: 'awaiting_approval',
        message: run.message,
        run,
      };
    }

    const currentNode = graph.nodes.find((node) => node.id === liveCheckpoint.currentNodeId);
    if (currentNode && currentNode.type === 'step') {
      const stepResult = updatedResults.find((result) => result.stepId === currentNode.step.id);
      if (stepResult && (stepResult.status === 'failed' || stepResult.status === 'denied') && !currentNode.step.continueOnError) {
        const failureEvents = [...nextEvents];
        failureEvents.push(createRunEvent(liveCheckpoint.runId, 'run_failed', this.now(), {
          nodeId: currentNode.id,
          message: stepResult.message,
        }));
        const failedCheckpoint = {
          ...updatedCheckpoint,
          status: 'failed' as const,
          events: failureEvents,
          nextNodeId: undefined,
        };
        this.graphRunner.getStore().save(failedCheckpoint);
        const existingRun = this.runs.find((run) => run.runId === liveCheckpoint.runId);
        const run = this.buildRunRecord(
          playbook,
          toRunInput(resumeContext),
          {
            runId: liveCheckpoint.runId,
            graphId: liveCheckpoint.graphId,
            graphName: liveCheckpoint.graphName,
            status: 'failed',
            message: stepResult.message,
            results: updatedResults,
            events: failureEvents,
            checkpoint: failedCheckpoint,
          },
          existingRun?.startedAt ?? liveCheckpoint.createdAt,
          existingRun?.id,
        );
        this.upsertRun(run);
        return {
          success: false,
          status: 'failed',
          message: run.message,
          run,
        };
      }
    }

    if (currentNode && currentNode.type === 'parallel') {
      const hardFailure = currentNode.steps.some((step) => {
        const result = updatedResults.find((entry) => entry.stepId === step.id);
        return !!result && (result.status === 'failed' || result.status === 'denied') && !step.continueOnError;
      });
      if (hardFailure) {
        const failureMessage = `Automation '${describeAutomation(playbook)}' completed with failures.`;
        const failureEvents = [...nextEvents];
        failureEvents.push(createRunEvent(liveCheckpoint.runId, 'run_failed', this.now(), {
          nodeId: currentNode.id,
          message: failureMessage,
        }));
        const failedCheckpoint = {
          ...updatedCheckpoint,
          status: 'failed' as const,
          events: failureEvents,
          nextNodeId: undefined,
        };
        this.graphRunner.getStore().save(failedCheckpoint);
        const existingRun = this.runs.find((run) => run.runId === liveCheckpoint.runId);
        const run = this.buildRunRecord(
          playbook,
          toRunInput(resumeContext),
          {
            runId: liveCheckpoint.runId,
            graphId: liveCheckpoint.graphId,
            graphName: liveCheckpoint.graphName,
            status: 'failed',
            message: failureMessage,
            results: updatedResults,
            events: failureEvents,
            checkpoint: failedCheckpoint,
          },
          existingRun?.startedAt ?? liveCheckpoint.createdAt,
          existingRun?.id,
        );
        this.upsertRun(run);
        return {
          success: false,
          status: 'failed',
          message: run.message,
          run,
        };
      }
    }

    const resumed = await this.graphRunner.resume(
      graph,
      liveCheckpoint.runId,
      this.buildGraphHandlers(playbook, toRunInput(resumeContext)),
    );
    const existingRun = this.runs.find((run) => run.runId === resumed.runId);
    const run = this.buildRunRecord(
      playbook,
      toRunInput(resumeContext),
      resumed,
      existingRun?.startedAt ?? liveCheckpoint.createdAt,
      existingRun?.id,
    );
    this.upsertRun(run);
    if (resumeContext.dryRun && run.status === 'succeeded') {
      this.dryRunQualified.add(playbook.id);
    }
    return {
      success: run.status === 'succeeded',
      status: run.status,
      message: run.message,
      run,
    };
  }

  private async executeStep(
    step: AssistantConnectorPlaybookStepDefinition,
    input: ConnectorPlaybookRunInput,
    priorResults?: PlaybookStepRunResult[],
  ): Promise<PlaybookStepRunResult> {
    if (step.type === 'instruction') {
      return this.executeInstructionStep(step, input, priorResults ?? []);
    }

    if (step.type === 'delay') {
      return this.executeDelayStep(step, input);
    }

    const startedAt = this.now();
    const scopedPackId = normalizeStepPackId(step.packId);
    const pack = scopedPackId
      ? this.config.packs.find((candidate) => candidate.id === scopedPackId)
      : undefined;
    if (scopedPackId && (!pack || !pack.enabled)) {
      return {
        stepId: step.id,
        toolName: step.toolName,
        packId: scopedPackId,
        status: 'failed',
        message: `Tool access profile '${scopedPackId}' is unavailable.`,
        durationMs: this.now() - startedAt,
      };
    }

    const args = isRecord(step.args)
      ? resolveStepTemplates(step.args, priorResults ?? [])
      : {};
    if (pack) {
      const capability = inferCapability(step.toolName);
      if (!capabilityAllowed(capability, pack.allowedCapabilities)) {
        return {
          stepId: step.id,
          toolName: step.toolName,
          packId: scopedPackId,
          status: 'failed',
          message: `Capability '${capability}' is not allowed for access profile '${pack.id}'.`,
          durationMs: this.now() - startedAt,
        };
      }

      const pathCheck = checkArgsPaths(args, pack.allowedPaths);
      if (!pathCheck.allowed) {
        return {
          stepId: step.id,
          toolName: step.toolName,
          packId: scopedPackId,
          status: 'failed',
          message: pathCheck.reason,
          durationMs: this.now() - startedAt,
        };
      }

      const commandCheck = checkArgsCommands(args, pack.allowedCommands);
      if (!commandCheck.allowed) {
        return {
          stepId: step.id,
          toolName: step.toolName,
          packId: scopedPackId,
          status: 'failed',
          message: commandCheck.reason,
          durationMs: this.now() - startedAt,
        };
      }

      const hostCheck = checkArgsHosts(args, pack.allowedHosts);
      if (!hostCheck.allowed) {
        return {
          stepId: step.id,
          toolName: step.toolName,
          packId: scopedPackId,
          status: 'failed',
          message: hostCheck.reason,
          durationMs: this.now() - startedAt,
        };
      }
    }

    const timeoutMs = step.timeoutMs ?? this.config.playbooks.defaultStepTimeoutMs;
    try {
      const toolResult = await withTimeout(
        this.runTool({
          toolName: step.toolName,
          args,
          origin: input.origin,
          agentId: input.agentId,
          userId: input.userId,
          channel: input.channel,
          dryRun: !!input.dryRun,
          bypassApprovals: input.bypassApprovals === true,
        }),
        timeoutMs,
      );

      const status: PlaybookStepStatus = toolResult.status === 'pending_approval'
        ? 'pending_approval'
        : toolResult.status === 'denied'
          ? 'denied'
          : toolResult.success
            ? 'succeeded'
            : 'failed';
      const evidenceBundle = extractEvidenceBundle(toolResult.output, step.id);

      return {
        stepId: step.id,
        toolName: step.toolName,
        packId: scopedPackId,
        status,
        message: toolResult.message,
        jobId: toolResult.jobId,
        approvalId: toolResult.approvalId,
        durationMs: this.now() - startedAt,
        output: toolResult.output,
        citations: evidenceBundle.citations,
        evidence: evidenceBundle.evidence,
      };
    } catch (err) {
      return {
        stepId: step.id,
        toolName: step.toolName,
        packId: scopedPackId,
        status: 'failed',
        message: err instanceof Error ? err.message : String(err),
        durationMs: this.now() - startedAt,
      };
    }
  }

  private async executeInstructionStep(
    step: AssistantConnectorPlaybookStepDefinition,
    input: ConnectorPlaybookRunInput,
    priorResults: PlaybookStepRunResult[],
  ): Promise<PlaybookStepRunResult> {
    const startedAt = this.now();

    if (!step.instruction?.trim()) {
      return {
        stepId: step.id,
        toolName: '_instruction',
        packId: '',
        status: 'failed',
        message: 'Instruction step has no instruction text.',
        durationMs: this.now() - startedAt,
      };
    }

    if (!this.runInstruction) {
      return {
        stepId: step.id,
        toolName: '_instruction',
        packId: '',
        status: 'failed',
        message: 'Instruction steps require an LLM provider but none is configured.',
        durationMs: this.now() - startedAt,
      };
    }

    // Dry-run: return synthetic success without calling the LLM.
    if (input.dryRun) {
      return {
        stepId: step.id,
        toolName: '_instruction',
        packId: '',
        status: 'succeeded',
        message: 'Instruction step (dry-run — LLM not called).',
        durationMs: this.now() - startedAt,
        output: '[dry-run: instruction output would appear here]',
      };
    }

    // Build context from prior step outputs.
    const context = priorResults
      .filter((r) => r.output != null)
      .map((r) => `### Step "${r.stepId}" (${r.toolName}) — ${r.status}\n${formatStepOutput(r.output)}`)
      .join('\n\n');
    const evidenceMode = step.evidenceMode ?? 'none';
    const citationStyle = step.citationStyle ?? 'sources_list';
    const evidenceBundle = collectPriorEvidence(priorResults);

    if (evidenceMode === 'strict' && evidenceBundle.citations.length === 0 && evidenceBundle.evidence.length === 0) {
      return {
        stepId: step.id,
        toolName: '_instruction',
        packId: '',
        status: 'failed',
        message: 'Instruction step requires evidence grounding, but prior steps did not capture citations or evidence.',
        durationMs: this.now() - startedAt,
      };
    }

    const prompt = [
      'You are processing an automation pipeline step.',
      'Below are the outputs from prior steps in this automation:\n',
      context || '(no prior step outputs)',
      evidenceBundle.promptSection,
      '\n---\n',
      'Your instruction for this step:\n',
      step.instruction,
      evidenceMode === 'none'
        ? '\nRespond with the requested output only. Do not explain the automation or reference these instructions.'
        : [
          '\nEvidence-grounding requirements:',
          '- Treat the evidence section as the factual boundary for consequential claims.',
          evidenceMode === 'strict'
            ? '- If the evidence is insufficient, say that the evidence is insufficient instead of filling gaps.'
            : '- Prefer evidence-backed wording and clearly mark uncertainty.',
          citationStyle === 'inline_markers'
            ? '- Cite supported claims inline using [Source N] markers.'
            : '- End with a short "Sources:" section that names the supporting sources or URLs you used.',
          'Respond with the requested output only. Do not explain the automation or reference these instructions.',
        ].join('\n'),
    ].join('\n');

    const timeoutMs = step.timeoutMs ?? this.config.playbooks.defaultStepTimeoutMs;
    try {
      const raw = await withTimeout(
        this.runInstruction(prompt, step.llmProvider, step.maxTokens ?? 2048),
        timeoutMs,
      );

      // Optionally scan LLM output (e.g. OutputGuardian secret/PII redaction).
      const output = this.scanOutput ? await this.scanOutput(raw) : raw;
      if (evidenceMode !== 'none' && !hasCitationReferences(output, evidenceBundle.citations, citationStyle)) {
        return {
          stepId: step.id,
          toolName: '_instruction',
          packId: '',
          status: evidenceMode === 'strict' ? 'failed' : 'succeeded',
          message: evidenceMode === 'strict'
            ? 'Instruction output omitted required citations for evidence-grounded mode.'
            : 'Instruction completed, but no explicit citations were detected in the response.',
          durationMs: this.now() - startedAt,
          output,
          citations: evidenceBundle.citations,
          evidence: evidenceBundle.evidence,
        };
      }

      return {
        stepId: step.id,
        toolName: '_instruction',
        packId: '',
        status: 'succeeded',
        message: 'Instruction completed.',
        durationMs: this.now() - startedAt,
        output,
        citations: evidenceBundle.citations,
        evidence: evidenceBundle.evidence,
      };
    } catch (err) {
      return {
        stepId: step.id,
        toolName: '_instruction',
        packId: '',
        status: 'failed',
        message: err instanceof Error ? err.message : String(err),
        durationMs: this.now() - startedAt,
      };
    }
  }

  private async executeDelayStep(
    step: AssistantConnectorPlaybookStepDefinition,
    input: ConnectorPlaybookRunInput,
  ): Promise<PlaybookStepRunResult> {
    const startedAt = this.now();
    const delayMs = step.delayMs;
    if (!delayMs || delayMs <= 0) {
      return {
        stepId: step.id,
        toolName: '_delay',
        packId: '',
        status: 'failed',
        message: 'Delay step requires delayMs > 0.',
        durationMs: this.now() - startedAt,
      };
    }

    // Ensure per-step timeout won't kill a valid delay
    if (!step.timeoutMs) {
      step.timeoutMs = delayMs + 5000;
    }

    if (input.dryRun) {
      return {
        stepId: step.id,
        toolName: '_delay',
        packId: '',
        status: 'succeeded',
        message: `Delay step: would pause for ${delayMs}ms (skipped in dry run).`,
        durationMs: this.now() - startedAt,
        output: `Dry run — skipped ${delayMs}ms delay.`,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));

    return {
      stepId: step.id,
      toolName: '_delay',
      packId: '',
      status: 'succeeded',
      message: `Paused for ${delayMs}ms.`,
      durationMs: this.now() - startedAt,
      output: `Delay completed (${delayMs}ms).`,
    };
  }

  private buildDeniedRun(
    input: ConnectorPlaybookRunInput,
    playbook: AssistantConnectorPlaybookDefinition | undefined,
    reason: string,
  ): ConnectorPlaybookRunResult {
    const now = this.now();
    const runId = randomUUID();
    const run: PlaybookRunRecord = {
      id: randomUUID(),
      playbookId: playbook?.id ?? input.playbookId,
      playbookName: playbook?.name ?? input.playbookId,
      runId,
      graphId: playbook?.id ?? input.playbookId,
      createdAt: now,
      startedAt: now,
      completedAt: now,
      durationMs: 0,
      dryRun: !!input.dryRun,
      status: 'failed',
      message: reason,
      steps: [],
      outputHandling: playbook?.outputHandling,
      requestedBy: input.requestedBy,
      origin: input.origin,
      events: [
        createRunEvent(runId, 'run_failed', now, {
          message: reason,
        }),
      ],
    };
    this.upsertRun(run);
    return { success: false, status: 'failed', message: reason, run };
  }
}

function parseResumeContext(value: Record<string, unknown> | undefined): PlaybookResumeContext | null {
  if (!value) return null;
  const playbookId = typeof value.playbookId === 'string' ? value.playbookId.trim() : '';
  const origin = value.origin === 'assistant' || value.origin === 'cli' || value.origin === 'web'
    ? value.origin
    : null;
  if (!playbookId || !origin) return null;
  return {
    playbookId,
    dryRun: value.dryRun === true,
    origin,
    agentId: typeof value.agentId === 'string' ? value.agentId : undefined,
    userId: typeof value.userId === 'string' ? value.userId : undefined,
    channel: typeof value.channel === 'string' ? value.channel : undefined,
    requestedBy: typeof value.requestedBy === 'string' ? value.requestedBy : undefined,
    bypassApprovals: value.bypassApprovals === true,
  };
}

function toRunInput(context: PlaybookResumeContext): ConnectorPlaybookRunInput {
  return {
    playbookId: context.playbookId,
    dryRun: context.dryRun,
    origin: context.origin,
    agentId: context.agentId,
    userId: context.userId,
    channel: context.channel,
    requestedBy: context.requestedBy,
    bypassApprovals: context.bypassApprovals,
  };
}

function compilePlaybookToGraph(playbook: AssistantConnectorPlaybookDefinition): PlaybookGraphDefinition {
  const graphId = `${playbook.id}:v1`;
  if (playbook.mode === 'parallel') {
    return {
      id: graphId,
      name: playbook.name,
      playbookId: playbook.id,
      entryNodeId: 'start',
      nodes: [
        { id: 'start', type: 'start', next: 'parallel' },
        { id: 'parallel', type: 'parallel', steps: playbook.steps.map((step) => ({ ...step })), next: 'end' },
        { id: 'end', type: 'end' },
      ],
    };
  }

  const nodes: PlaybookGraphDefinition['nodes'] = [{ id: 'start', type: 'start', next: playbook.steps[0]?.id || 'end' }];
  for (const [index, step] of playbook.steps.entries()) {
    nodes.push({
      id: step.id,
      type: 'step',
      step: { ...step },
      next: playbook.steps[index + 1]?.id || 'end',
    });
  }
  nodes.push({ id: 'end', type: 'end' });
  return {
    id: graphId,
    name: playbook.name,
    playbookId: playbook.id,
    entryNodeId: 'start',
    nodes,
  };
}

function capabilityAllowed(capability: string, allowedCapabilities: string[]): boolean {
  if (allowedCapabilities.length === 0) return false;
  return allowedCapabilities.includes('*') || allowedCapabilities.includes(capability);
}

function normalizeStepPackId(packId: string | null | undefined): string {
  const normalized = (packId ?? '').trim();
  if (!normalized) return '';
  return normalized.toLowerCase() === 'default' ? '' : normalized;
}

function inferCapability(toolName: string): string {
  if (toolName.startsWith('fs_') || toolName === 'doc_create') {
    return toolName === 'fs_read' || toolName === 'fs_list' || toolName === 'fs_search'
      ? 'filesystem.read'
      : 'filesystem.write';
  }
  if (toolName === 'shell_safe' || toolName === 'run_command') return 'shell.execute';
  if (toolName.startsWith('contacts_') || toolName.startsWith('campaign_') || toolName.startsWith('gmail_')) {
    return 'email.workflow';
  }
  if (toolName.startsWith('intel_') || toolName === 'forum_post') return 'intel.operations';
  if (toolName.startsWith('net_')) return 'network.read';
  if (toolName.startsWith('sys_')) return 'system.read';
  if (toolName.startsWith('mcp-')) return 'mcp.tools';
  return 'network.http';
}

function checkArgsPaths(args: Record<string, unknown>, allowedPaths: string[]): { allowed: boolean; reason: string } {
  const keys = ['path', 'filePath', 'targetPath', 'outputPath', 'workspacePath', 'csvPath'];
  const candidates = keys
    .map((key) => args[key])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

  for (const candidate of candidates) {
    if (!isPathWithinAllowedRoots(candidate, allowedPaths)) {
      return { allowed: false, reason: `Path '${candidate}' is outside the allowed paths for this access profile.` };
    }
  }
  return { allowed: true, reason: 'ok' };
}

function checkArgsCommands(args: Record<string, unknown>, allowedCommands: string[]): { allowed: boolean; reason: string } {
  const keys = ['command', 'cmd'];
  const candidates = keys
    .map((key) => args[key])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

  for (const candidate of candidates) {
    const normalized = candidate.trim();
    const allowed = allowedCommands.some((prefix) =>
      normalized === prefix || normalized.startsWith(`${prefix} `),
    );
    if (!allowed) {
      return { allowed: false, reason: `Command '${candidate}' is outside the allowed commands for this access profile.` };
    }
  }
  return { allowed: true, reason: 'ok' };
}

function checkArgsHosts(args: Record<string, unknown>, allowedHosts: string[]): { allowed: boolean; reason: string } {
  const keys = ['url', 'baseUrl', 'endpoint', 'targetUrl'];
  const candidates = keys
    .map((key) => args[key])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      const host = url.hostname.toLowerCase();
      const allowed = allowedHosts.some((allowedHost) => {
        const normalized = allowedHost.trim().toLowerCase();
        return host === normalized || host.endsWith(`.${normalized}`);
      });
      if (!allowed) {
        return { allowed: false, reason: `Host '${host}' is outside the allowed hosts for this access profile.` };
      }
    } catch {
      return { allowed: false, reason: `Invalid URL '${candidate}'.` };
    }
  }
  return { allowed: true, reason: 'ok' };
}

function normalizePathValue(value: string): string {
  const trimmed = value.trim();
  const resolved = isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed);
  return resolved.replaceAll('\\', '/').toLowerCase();
}

function isPathWithinAllowedRoots(candidate: string, allowedRoots: string[]): boolean {
  const normalizedCandidate = normalizePathValue(candidate);
  for (const root of allowedRoots) {
    const normalizedRoot = normalizePathValue(root);
    if (normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`)) {
      return true;
    }
  }
  return false;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Step timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneConnectorsConfig(config: AssistantConnectorsConfig): AssistantConnectorsConfig {
  return {
    enabled: config.enabled,
    executionMode: config.executionMode,
    maxConnectorCallsPerRun: config.maxConnectorCallsPerRun,
    packs: config.packs.map(clonePack),
    playbooks: {
      ...config.playbooks,
      definitions: config.playbooks.definitions.map(clonePlaybook),
    },
    studio: { ...config.studio },
  };
}

function clonePack(pack: AssistantConnectorPackConfig): AssistantConnectorPackConfig {
  return {
    ...pack,
    allowedCapabilities: [...pack.allowedCapabilities],
    allowedHosts: [...pack.allowedHosts],
    allowedPaths: [...pack.allowedPaths],
    allowedCommands: [...pack.allowedCommands],
  };
}

function clonePlaybook(playbook: AssistantConnectorPlaybookDefinition): AssistantConnectorPlaybookDefinition {
  return {
    ...playbook,
    outputHandling: playbook.outputHandling ? { ...playbook.outputHandling } : undefined,
    steps: playbook.steps.map(cloneStep),
  };
}

function cloneStep(step: AssistantConnectorPlaybookStepDefinition): AssistantConnectorPlaybookStepDefinition {
  return {
    ...step,
    args: step.args ? { ...step.args } : undefined,
  };
}

function resolveStepTemplates(
  value: Record<string, unknown>,
  priorResults: PlaybookStepRunResult[],
): Record<string, unknown> {
  return resolveTemplateValue(value, priorResults) as Record<string, unknown>;
}

function resolveTemplateValue(value: unknown, priorResults: PlaybookStepRunResult[]): unknown {
  if (typeof value === 'string') {
    return replaceStepPlaceholders(value, priorResults);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => resolveTemplateValue(entry, priorResults));
  }
  if (isRecord(value)) {
    const resolved: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      resolved[key] = resolveTemplateValue(entry, priorResults);
    }
    return resolved;
  }
  return value;
}

function replaceStepPlaceholders(template: string, priorResults: PlaybookStepRunResult[]): unknown {
  const exactMatch = template.match(/^\$\{([^.}]+)\.(output|message|status)(?:\.([^}]+))?\}$/);
  if (exactMatch) {
    return resolveStepPlaceholderValue(exactMatch[1], exactMatch[2], exactMatch[3], priorResults);
  }

  return template.replace(/\$\{([^.}]+)\.(output|message|status)(?:\.([^}]+))?\}/g, (_match, stepId: string, field: string, path: string | undefined) => {
    const resolved = resolveStepPlaceholderValue(stepId, field, path, priorResults);
    return typeof resolved === 'string' ? resolved : formatStepOutput(resolved);
  });
}

function resolveStepPlaceholderValue(
  stepId: string,
  field: string,
  path: string | undefined,
  priorResults: PlaybookStepRunResult[],
): unknown {
  const step = priorResults.find((result) => result.stepId === stepId);
  if (!step) return '';
  if (field === 'output') {
    const output = step.output ?? '';
    return path ? resolveNestedTemplatePath(output, path) : output;
  }
  if (field === 'message') return step.message;
  if (field === 'status') return step.status;
  return '';
}

function resolveNestedTemplatePath(value: unknown, path: string): unknown {
  const segments = path
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean);
  let current: unknown = value;
  for (const segment of segments) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number.parseInt(segment, 10)];
      continue;
    }
    if (!isRecord(current)) return '';
    current = current[segment];
  }
  return current ?? '';
}

function formatStepOutput(output: unknown): string {
  if (output === null || output === undefined) return '';
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

function collectPriorEvidence(
  priorResults: PlaybookStepRunResult[],
): { citations: PlaybookCitation[]; evidence: PlaybookEvidenceItem[]; promptSection: string } {
  const citations: PlaybookCitation[] = [];
  const evidence: PlaybookEvidenceItem[] = [];

  for (const result of priorResults) {
    if (result.citations?.length) {
      citations.push(...result.citations.map((citation) => ({ ...citation })));
    }
    if (result.evidence?.length) {
      evidence.push(...result.evidence.map((item) => ({ ...item })));
    }
  }

  if (citations.length === 0 && evidence.length === 0) {
    return {
      citations,
      evidence,
      promptSection: '',
    };
  }

  const lines = ['\nStructured evidence captured from prior steps:'];
  citations.slice(0, 8).forEach((citation, index) => {
    lines.push(`- Source ${index + 1}: ${citation.title || citation.url} (${citation.url})${citation.snippet ? ` — ${citation.snippet}` : ''}`);
  });
  evidence.slice(0, 8).forEach((item, index) => {
    lines.push(`- Evidence ${index + 1}: ${item.summary}${item.url ? ` (${item.url})` : ''}`);
  });

  return {
    citations,
    evidence,
    promptSection: lines.join('\n'),
  };
}

function extractEvidenceBundle(
  output: unknown,
  sourceStepId: string,
): { citations: PlaybookCitation[]; evidence: PlaybookEvidenceItem[] } {
  const citations: PlaybookCitation[] = [];
  const evidence: PlaybookEvidenceItem[] = [];

  if (isRecord(output)) {
    const explicitCitations = output.citations;
    if (Array.isArray(explicitCitations)) {
      for (const entry of explicitCitations) {
        if (typeof entry === 'string' && entry.trim()) {
          citations.push({
            title: entry.trim(),
            url: entry.trim(),
            sourceStepId,
          });
          evidence.push({
            kind: 'citation',
            summary: entry.trim(),
            url: entry.trim(),
            sourceStepId,
          });
        } else if (isRecord(entry) && typeof entry.url === 'string' && entry.url.trim()) {
          const title = typeof entry.title === 'string' ? entry.title : entry.url;
          const snippet = typeof entry.snippet === 'string' ? entry.snippet : undefined;
          citations.push({
            title,
            url: entry.url.trim(),
            snippet,
            sourceStepId,
          });
          evidence.push({
            kind: 'citation',
            summary: snippet ? `${title}: ${snippet}` : title,
            url: entry.url.trim(),
            sourceStepId,
          });
        }
      }
    }

    const results = output.results;
    if (Array.isArray(results)) {
      for (const entry of results) {
        if (!isRecord(entry) || typeof entry.url !== 'string' || !entry.url.trim()) continue;
        const title = typeof entry.title === 'string' ? entry.title : entry.url;
        const snippet = typeof entry.snippet === 'string' ? entry.snippet : undefined;
        citations.push({
          title,
          url: entry.url.trim(),
          snippet,
          sourceStepId,
        });
        evidence.push({
          kind: 'search_result',
          summary: snippet ? `${title}: ${snippet}` : title,
          url: entry.url.trim(),
          sourceStepId,
        });
      }
    }

    const explicitEvidence = output.evidence;
    if (Array.isArray(explicitEvidence)) {
      for (const entry of explicitEvidence) {
        if (!isRecord(entry)) continue;
        const summary = typeof entry.summary === 'string'
          ? entry.summary
          : formatStepOutput(entry);
        evidence.push({
          kind: entry.kind === 'search_result' || entry.kind === 'citation' || entry.kind === 'page_excerpt'
            ? entry.kind
            : 'structured_output',
          summary,
          url: typeof entry.url === 'string' ? entry.url : undefined,
          sourceStepId,
        });
      }
    }
  }

  return {
    citations: dedupeCitations(citations),
    evidence: dedupeEvidence(evidence),
  };
}

function dedupeCitations(citations: PlaybookCitation[]): PlaybookCitation[] {
  const seen = new Set<string>();
  const result: PlaybookCitation[] = [];
  for (const citation of citations) {
    const signature = `${citation.url}|${citation.title}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    result.push(citation);
  }
  return result;
}

function dedupeEvidence(evidence: PlaybookEvidenceItem[]): PlaybookEvidenceItem[] {
  const seen = new Set<string>();
  const result: PlaybookEvidenceItem[] = [];
  for (const item of evidence) {
    const signature = `${item.kind}|${item.url ?? ''}|${item.summary}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    result.push(item);
  }
  return result;
}

function hasCitationReferences(
  output: string,
  citations: PlaybookCitation[],
  citationStyle: NonNullable<AssistantConnectorPlaybookStepDefinition['citationStyle']>,
): boolean {
  const trimmed = output.trim();
  if (!trimmed) return false;
  if (citationStyle === 'inline_markers' && /\[Source\s+\d+\]/i.test(trimmed)) {
    return true;
  }
  if (/^Sources:/im.test(trimmed)) {
    return true;
  }
  return citations.some((citation) => trimmed.includes(citation.url));
}

function describeAutomation(
  playbook: Pick<AssistantConnectorPlaybookDefinition, 'id' | 'name'> | undefined,
): string {
  return playbook?.name?.trim() || playbook?.id?.trim() || 'automation';
}
