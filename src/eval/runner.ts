/**
 * Evaluation runner — executes test suites against agent instances.
 *
 * Loads test cases (from code or .eval.json files), dispatches messages
 * to agents via the Runtime, collects responses, and evaluates them
 * against expected criteria using the metrics module.
 *
 * Integrates with vitest for CI: each test case becomes a vitest test.
 */

import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Runtime } from '../runtime/runtime.js';
import type {
  EvalTestCase,
  EvalTestResult,
  EvalSuiteResult,
  EvalSummary,
  EvalActualResponse,
  EvalAssertionResult,
  EvalSuiteFile,
  EvalTestCaseJSON,
} from './types.js';
import {
  evaluateContent,
  evaluateToolTrajectory,
  evaluateMetadata,
  evaluateSafety,
} from './metrics.js';

// ─── Eval Runner ──────────────────────────────────────────────

export interface EvalRunnerOptions {
  /** The runtime instance to dispatch messages through. */
  runtime: Runtime;
  /** Default timeout per test case in ms. Default: 30000. */
  defaultTimeoutMs?: number;
}

/**
 * Runs evaluation test suites against the agent runtime.
 *
 * All agent invocations go through the full Runtime dispatch path,
 * which means Guardian, OutputGuardian, budget tracking, etc. are
 * all active during evaluation — testing the real security posture.
 */
export class EvalRunner {
  private runtime: Runtime;
  private defaultTimeoutMs: number;

  constructor(options: EvalRunnerOptions) {
    this.runtime = options.runtime;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  }

  /** Run a suite of test cases. */
  async runSuite(name: string, tests: EvalTestCase[]): Promise<EvalSuiteResult> {
    const suiteStart = performance.now();
    const results: EvalTestResult[] = [];

    for (const test of tests) {
      const result = await this.runTest(test);
      results.push(result);
    }

    const durationMs = performance.now() - suiteStart;
    const summary = this.computeSummary(results);

    return { name, results, summary, durationMs };
  }

  /** Run a single test case. */
  async runTest(test: EvalTestCase): Promise<EvalTestResult> {
    const testStart = performance.now();
    const timeoutMs = test.timeoutMs ?? this.defaultTimeoutMs;

    try {
      // Build the user message
      const message = {
        id: randomUUID(),
        userId: test.input.userId ?? 'eval-user',
        channel: test.input.channel ?? 'eval',
        content: test.input.content,
        timestamp: Date.now(),
      };

      // Dispatch with timeout
      const response = await withTimeout(
        this.runtime.dispatchMessage(test.agentId, message),
        timeoutMs,
        `Test '${test.name}' timed out after ${timeoutMs}ms`,
      );

      const durationMs = performance.now() - testStart;

      const actual: EvalActualResponse = {
        content: response.content,
        metadata: response.metadata,
        toolCalls: [],
        durationMs,
      };

      // Run assertions
      const assertions = this.evaluate(actual, test);

      return {
        name: test.name,
        passed: assertions.every(a => a.passed),
        assertions,
        actual,
        durationMs,
      };

    } catch (err) {
      const durationMs = performance.now() - testStart;
      const errorMsg = err instanceof Error ? err.message : String(err);

      return {
        name: test.name,
        passed: false,
        assertions: [{
          passed: false,
          metric: 'execution',
          reason: `Test execution failed: ${errorMsg}`,
        }],
        actual: {
          content: '',
          durationMs,
          error: errorMsg,
        },
        durationMs,
        error: errorMsg,
      };
    }
  }

  /** Evaluate an actual response against test case expectations. */
  private evaluate(actual: EvalActualResponse, test: EvalTestCase): EvalAssertionResult[] {
    const results: EvalAssertionResult[] = [];
    const expected = test.expected;

    // Content matching
    if (expected.content) {
      results.push(evaluateContent(actual.content, expected.content));
    }

    // Tool trajectory
    if (expected.toolCalls && actual.toolCalls) {
      results.push(evaluateToolTrajectory(actual.toolCalls, expected.toolCalls));
    }

    // Metadata matching
    if (expected.metadata) {
      results.push(evaluateMetadata(actual.metadata, expected.metadata));
    }

    // Safety checks
    if (expected.safety) {
      results.push(...evaluateSafety(actual, expected.safety));
    }

    // Custom assertion
    if (expected.custom) {
      results.push(expected.custom(actual));
    }

    // If no expectations were set, at least check that the response is non-empty
    if (results.length === 0) {
      results.push({
        passed: actual.content.length > 0,
        metric: 'response_exists',
        reason: actual.content.length > 0
          ? 'Agent produced a non-empty response'
          : 'Agent produced an empty response',
      });
    }

    return results;
  }

  /** Compute summary statistics from test results. */
  private computeSummary(results: EvalTestResult[]): EvalSummary {
    const total = results.length;
    const passed = results.filter(r => r.passed && !r.error).length;
    const errors = results.filter(r => r.error).length;
    const failed = total - passed - errors;

    // Per-metric pass rates
    const metricCounts: Record<string, { passed: number; total: number }> = {};

    for (const result of results) {
      for (const assertion of result.assertions) {
        if (!metricCounts[assertion.metric]) {
          metricCounts[assertion.metric] = { passed: 0, total: 0 };
        }
        metricCounts[assertion.metric].total++;
        if (assertion.passed) {
          metricCounts[assertion.metric].passed++;
        }
      }
    }

    const metricPassRates: Record<string, { passed: number; total: number; rate: number }> = {};
    for (const [metric, counts] of Object.entries(metricCounts)) {
      metricPassRates[metric] = {
        ...counts,
        rate: counts.total > 0 ? counts.passed / counts.total : 0,
      };
    }

    return {
      total,
      passed,
      failed,
      errors,
      passRate: total > 0 ? passed / total : 0,
      metricPassRates,
    };
  }
}

// ─── JSON Suite Loader ────────────────────────────────────────

/**
 * Load an evaluation suite from a .eval.json file.
 *
 * Converts JSON test cases to the full EvalTestCase format.
 */
export async function loadEvalSuite(filePath: string): Promise<{
  name: string;
  tests: EvalTestCase[];
}> {
  const raw = await readFile(filePath, 'utf-8');
  const suite: EvalSuiteFile = JSON.parse(raw);

  const tests: EvalTestCase[] = suite.tests.map((t: EvalTestCaseJSON) => ({
    name: t.name,
    description: t.description,
    tags: t.tags,
    agentId: t.agentId ?? suite.defaultAgentId ?? 'default',
    input: t.input,
    expected: t.expected,
    timeoutMs: t.timeoutMs ?? suite.defaultTimeoutMs,
  }));

  return { name: suite.name, tests };
}

/**
 * Format eval results as a human-readable report.
 */
export function formatEvalReport(result: EvalSuiteResult): string {
  const lines: string[] = [];
  const { summary } = result;

  lines.push(`\n${'═'.repeat(60)}`);
  lines.push(`  Evaluation: ${result.name}`);
  lines.push(`${'═'.repeat(60)}\n`);

  for (const test of result.results) {
    const status = test.error ? 'ERR' : test.passed ? 'PASS' : 'FAIL';
    const icon = test.error ? 'x' : test.passed ? '+' : '-';
    lines.push(`  [${icon}] ${status}  ${test.name} (${Math.round(test.durationMs)}ms)`);

    if (!test.passed) {
      for (const assertion of test.assertions) {
        if (!assertion.passed) {
          lines.push(`         ${assertion.metric}: ${assertion.reason}`);
        }
      }
    }
  }

  lines.push(`\n${'─'.repeat(60)}`);
  lines.push(`  Total: ${summary.total}  Passed: ${summary.passed}  Failed: ${summary.failed}  Errors: ${summary.errors}`);
  lines.push(`  Pass rate: ${(summary.passRate * 100).toFixed(1)}%`);

  if (Object.keys(summary.metricPassRates).length > 0) {
    lines.push(`\n  Per-metric pass rates:`);
    for (const [metric, rates] of Object.entries(summary.metricPassRates)) {
      lines.push(`    ${metric}: ${rates.passed}/${rates.total} (${(rates.rate * 100).toFixed(0)}%)`);
    }
  }

  lines.push(`\n  Duration: ${Math.round(result.durationMs)}ms`);
  lines.push(`${'═'.repeat(60)}\n`);

  return lines.join('\n');
}

// ─── Helpers ──────────────────────────────────────────────────

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise
      .then((value) => { clearTimeout(timer); resolve(value); })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });
}
