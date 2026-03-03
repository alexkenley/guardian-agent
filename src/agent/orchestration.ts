/**
 * Orchestration agents — structured multi-agent composition patterns.
 *
 * Inspired by Google ADK's SequentialAgent/ParallelAgent/LoopAgent,
 * but integrated with GuardianAgent's security model. All sub-agent
 * invocations pass through the Guardian admission pipeline.
 *
 * Patterns:
 *   SequentialAgent — runs sub-agents in order, passing state between steps
 *   ParallelAgent   — runs sub-agents concurrently, collecting all results
 *   LoopAgent       — runs a sub-agent repeatedly until a condition is met
 */

import { BaseAgent } from './agent.js';
import type {
  AgentContext,
  AgentResponse,
  UserMessage,
} from './types.js';
import { SharedState } from '../runtime/shared-state.js';

// ─── Orchestration Types ──────────────────────────────────────

/** A single step in an orchestration pipeline. */
export interface OrchestrationStep {
  /** Target agent ID to invoke. */
  agentId: string;
  /**
   * Key in shared state to read as input content override.
   * If set and the key exists, this value replaces the user message content.
   */
  inputKey?: string;
  /**
   * Key in shared state to write this step's response content.
   * If not set, defaults to the agent ID.
   */
  outputKey?: string;
}

/** Options for SequentialAgent construction. */
export interface SequentialAgentOptions {
  /** Ordered list of steps to execute. */
  steps: OrchestrationStep[];
  /**
   * Whether to stop the pipeline on the first step that returns an error.
   * Default: true.
   */
  stopOnError?: boolean;
}

/** Options for ParallelAgent construction. */
export interface ParallelAgentOptions {
  /** Steps to execute concurrently. */
  steps: OrchestrationStep[];
  /**
   * Maximum concurrent invocations. 0 = unlimited.
   * Default: 0.
   */
  maxConcurrency?: number;
}

/** Condition function for LoopAgent — return true to continue looping. */
export type LoopCondition = (
  iteration: number,
  lastResponse: AgentResponse | undefined,
  state: SharedState,
) => boolean;

/** Options for LoopAgent construction. */
export interface LoopAgentOptions {
  /** Agent to invoke on each iteration. */
  agentId: string;
  /** Key in shared state to read as input for each iteration. */
  inputKey?: string;
  /** Key in shared state to write each iteration's output. */
  outputKey?: string;
  /**
   * Continue looping while this returns true.
   * Default: loops while the last response content is non-empty, up to maxIterations.
   */
  condition?: LoopCondition;
  /** Maximum iterations to prevent infinite loops. Default: 10. */
  maxIterations?: number;
}

// ─── Sequential Agent ─────────────────────────────────────────

/**
 * Runs sub-agents in sequence, passing state between steps.
 *
 * Each step can read its input from shared state (via inputKey) and
 * writes its output to shared state (via outputKey or agent ID).
 * The final step's response is returned as the overall response.
 *
 * All sub-agent calls go through `ctx.dispatch()` which enforces
 * the full Guardian admission pipeline.
 */
export class SequentialAgent extends BaseAgent {
  private steps: OrchestrationStep[];
  private stopOnError: boolean;

  constructor(id: string, name: string, options: SequentialAgentOptions) {
    super(id, name, { handleMessages: true, handleEvents: false, handleSchedule: false });
    this.steps = options.steps;
    this.stopOnError = options.stopOnError ?? true;
  }

  async onMessage(message: UserMessage, ctx: AgentContext): Promise<AgentResponse> {
    if (!ctx.dispatch) {
      return { content: '[SequentialAgent requires dispatch capability in context]' };
    }

    const state = new SharedState();
    // Seed the initial message content
    state.set('input', message.content);

    const stepResults: Array<{ agentId: string; response: AgentResponse }> = [];

    for (const step of this.steps) {
      // Determine input content for this step
      let inputContent = message.content;
      if (step.inputKey && state.has(step.inputKey)) {
        const stateValue = state.get<string>(step.inputKey);
        if (typeof stateValue === 'string') {
          inputContent = stateValue;
        }
      }

      const stepMessage: UserMessage = {
        ...message,
        content: inputContent,
      };

      try {
        const response = await ctx.dispatch(step.agentId, stepMessage);
        const outputKey = step.outputKey ?? step.agentId;
        state.set(outputKey, response.content);
        stepResults.push({ agentId: step.agentId, response });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const outputKey = step.outputKey ?? step.agentId;
        state.set(outputKey, `[Error: ${errorMsg}]`);

        if (this.stopOnError) {
          state.clearTemp();
          return {
            content: `[Pipeline stopped at step '${step.agentId}': ${errorMsg}]`,
            metadata: {
              orchestration: 'sequential',
              stoppedAt: step.agentId,
              completedSteps: stepResults.length,
              totalSteps: this.steps.length,
              state: state.snapshot(),
            },
          };
        }
      }
    }

    state.clearTemp();

    // Return the last successful step's response
    const lastResult = stepResults[stepResults.length - 1];
    return {
      content: lastResult?.response.content ?? '[No steps completed]',
      metadata: {
        orchestration: 'sequential',
        completedSteps: stepResults.length,
        totalSteps: this.steps.length,
        state: state.snapshot(),
      },
    };
  }
}

// ─── Parallel Agent ───────────────────────────────────────────

/**
 * Runs sub-agents concurrently, collecting all results.
 *
 * All steps execute in parallel (optionally limited by maxConcurrency).
 * Results are written to shared state under each step's outputKey.
 * The combined results are returned as the overall response.
 *
 * All sub-agent calls go through `ctx.dispatch()` which enforces
 * the full Guardian admission pipeline.
 */
export class ParallelAgent extends BaseAgent {
  private steps: OrchestrationStep[];
  private maxConcurrency: number;

  constructor(id: string, name: string, options: ParallelAgentOptions) {
    super(id, name, { handleMessages: true, handleEvents: false, handleSchedule: false });
    this.steps = options.steps;
    this.maxConcurrency = options.maxConcurrency ?? 0;
  }

  async onMessage(message: UserMessage, ctx: AgentContext): Promise<AgentResponse> {
    if (!ctx.dispatch) {
      return { content: '[ParallelAgent requires dispatch capability in context]' };
    }

    const state = new SharedState();
    state.set('input', message.content);

    const executeStep = async (step: OrchestrationStep): Promise<{
      agentId: string;
      response?: AgentResponse;
      error?: string;
    }> => {
      let inputContent = message.content;
      if (step.inputKey && state.has(step.inputKey)) {
        const stateValue = state.get<string>(step.inputKey);
        if (typeof stateValue === 'string') {
          inputContent = stateValue;
        }
      }

      const stepMessage: UserMessage = { ...message, content: inputContent };

      try {
        const response = await ctx.dispatch!(step.agentId, stepMessage);
        const outputKey = step.outputKey ?? step.agentId;
        state.set(outputKey, response.content);
        return { agentId: step.agentId, response };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const outputKey = step.outputKey ?? step.agentId;
        state.set(outputKey, `[Error: ${errorMsg}]`);
        return { agentId: step.agentId, error: errorMsg };
      }
    };

    let results: Awaited<ReturnType<typeof executeStep>>[];

    if (this.maxConcurrency > 0) {
      results = await this.runWithConcurrencyLimit(this.steps, executeStep, this.maxConcurrency);
    } else {
      results = await Promise.all(this.steps.map(executeStep));
    }

    state.clearTemp();

    // Combine results
    const succeeded = results.filter(r => r.response);
    const failed = results.filter(r => r.error);

    const combinedContent = results
      .map(r => {
        if (r.response) return `[${r.agentId}]: ${r.response.content}`;
        return `[${r.agentId}]: Error — ${r.error}`;
      })
      .join('\n\n');

    return {
      content: combinedContent,
      metadata: {
        orchestration: 'parallel',
        totalSteps: this.steps.length,
        succeeded: succeeded.length,
        failed: failed.length,
        state: state.snapshot(),
      },
    };
  }

  /** Execute tasks with a concurrency limit using a simple pool. */
  private async runWithConcurrencyLimit<T, R>(
    items: T[],
    fn: (item: T) => Promise<R>,
    limit: number,
  ): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await fn(items[index]);
      }
    };

    const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
  }
}

// ─── Loop Agent ───────────────────────────────────────────────

/**
 * Runs a single sub-agent repeatedly until a condition is met.
 *
 * Each iteration can feed the previous iteration's output as input.
 * Includes a mandatory maxIterations cap to prevent infinite loops.
 *
 * All sub-agent calls go through `ctx.dispatch()` which enforces
 * the full Guardian admission pipeline.
 */
export class LoopAgent extends BaseAgent {
  private targetAgentId: string;
  private inputKey?: string;
  private outputKey?: string;
  private condition: LoopCondition;
  private maxIterations: number;

  constructor(id: string, name: string, options: LoopAgentOptions) {
    super(id, name, { handleMessages: true, handleEvents: false, handleSchedule: false });
    this.targetAgentId = options.agentId;
    this.inputKey = options.inputKey;
    this.outputKey = options.outputKey;
    this.maxIterations = options.maxIterations ?? 10;
    this.condition = options.condition ?? ((iteration, lastResponse) => {
      if (iteration >= this.maxIterations) return false;
      if (!lastResponse) return true;
      return lastResponse.content.length > 0 && !lastResponse.content.startsWith('[Error');
    });
  }

  async onMessage(message: UserMessage, ctx: AgentContext): Promise<AgentResponse> {
    if (!ctx.dispatch) {
      return { content: '[LoopAgent requires dispatch capability in context]' };
    }

    const state = new SharedState();
    state.set('input', message.content);

    let lastResponse: AgentResponse | undefined;
    let iteration = 0;

    while (iteration < this.maxIterations && this.condition(iteration, lastResponse, state)) {
      // Determine input content
      let inputContent = message.content;
      if (this.inputKey && state.has(this.inputKey)) {
        const stateValue = state.get<string>(this.inputKey);
        if (typeof stateValue === 'string') {
          inputContent = stateValue;
        }
      } else if (lastResponse) {
        // Default: feed previous iteration's output as input
        inputContent = lastResponse.content;
      }

      const stepMessage: UserMessage = { ...message, content: inputContent };

      try {
        lastResponse = await ctx.dispatch(this.targetAgentId, stepMessage);
        const outputKey = this.outputKey ?? this.targetAgentId;
        state.set(outputKey, lastResponse.content);
        state.set('temp:iteration', iteration);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        state.clearTemp();
        return {
          content: `[Loop stopped at iteration ${iteration}: ${errorMsg}]`,
          metadata: {
            orchestration: 'loop',
            iterations: iteration,
            maxIterations: this.maxIterations,
            stoppedByError: true,
          },
        };
      }

      iteration++;
    }

    state.clearTemp();

    return {
      content: lastResponse?.content ?? '[No iterations completed]',
      metadata: {
        orchestration: 'loop',
        iterations: iteration,
        maxIterations: this.maxIterations,
        state: state.snapshot(),
      },
    };
  }
}
