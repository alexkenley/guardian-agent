/**
 * Agent evaluation framework types.
 *
 * Inspired by Google ADK's .test.json evaluation format.
 * Defines test cases as message inputs → expected outputs/tool calls,
 * with metrics for response quality, trajectory, and safety.
 */

// ─── Test Case Definitions ────────────────────────────────────

/** A single evaluation test case. */
export interface EvalTestCase {
  /** Unique test case name for reporting. */
  name: string;
  /** Optional description of what this test validates. */
  description?: string;
  /** Tags for filtering (e.g., 'safety', 'routing', 'tool_use'). */
  tags?: string[];
  /** The agent ID to test. */
  agentId: string;
  /** Input message to send to the agent. */
  input: EvalInput;
  /** Expected output criteria. */
  expected: EvalExpected;
  /** Optional timeout in ms (default: 30000). */
  timeoutMs?: number;
}

/** Input specification for a test case. */
export interface EvalInput {
  /** User message content. */
  content: string;
  /** User ID (default: 'eval-user'). */
  userId?: string;
  /** Channel (default: 'eval'). */
  channel?: string;
  /** Previous messages for multi-turn context. */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

/** Expected output criteria for evaluation. */
export interface EvalExpected {
  /**
   * Response content matching.
   * Can be exact string, substring, or regex pattern.
   */
  content?: ContentMatcher;
  /**
   * Expected tool calls in order.
   * If set, validates the trajectory (which tools were called and in what order).
   */
  toolCalls?: ExpectedToolCall[];
  /**
   * Expected metadata keys/values in the response.
   */
  metadata?: Record<string, unknown>;
  /**
   * Safety checks that must pass.
   */
  safety?: SafetyExpectation;
  /**
   * Custom assertion function for complex validations.
   * Receives the actual response and returns pass/fail with reason.
   */
  custom?: (response: EvalActualResponse) => EvalAssertionResult;
}

/** Content matching strategies. */
export type ContentMatcher =
  | { type: 'exact'; value: string }
  | { type: 'contains'; value: string }
  | { type: 'regex'; pattern: string; flags?: string }
  | { type: 'not_contains'; value: string }
  | { type: 'not_empty' };

/** Expected tool call in the trajectory. */
export interface ExpectedToolCall {
  /** Tool name that should have been called. */
  toolName: string;
  /** Expected arguments (subset match — only listed args are checked). */
  args?: Record<string, unknown>;
  /** Whether this call is optional. Default: false. */
  optional?: boolean;
}

/** Safety expectations for the response. */
export interface SafetyExpectation {
  /** Response must not contain secrets. Default: true. */
  noSecrets?: boolean;
  /** Response must not contain blocked content patterns. */
  noBlockedPatterns?: string[];
  /** Guardian must not have denied the action. */
  noDenials?: boolean;
  /** Injection score must be below this threshold. */
  maxInjectionScore?: number;
}

// ─── Evaluation Results ───────────────────────────────────────

/** The actual response received from the agent. */
export interface EvalActualResponse {
  /** Response content. */
  content: string;
  /** Response metadata. */
  metadata?: Record<string, unknown>;
  /** Tool calls that were made during the invocation. */
  toolCalls?: Array<{ toolName: string; args: Record<string, unknown> }>;
  /** Duration of the invocation in ms. */
  durationMs: number;
  /** Whether the invocation threw an error. */
  error?: string;
}

/** Result of a single assertion. */
export interface EvalAssertionResult {
  /** Whether the assertion passed. */
  passed: boolean;
  /** Metric name (e.g., 'content_match', 'tool_trajectory', 'safety'). */
  metric: string;
  /** Human-readable reason for pass/fail. */
  reason: string;
  /** Expected value (for display). */
  expected?: unknown;
  /** Actual value (for display). */
  actual?: unknown;
}

/** Result of evaluating a single test case. */
export interface EvalTestResult {
  /** Test case name. */
  name: string;
  /** Overall pass/fail. */
  passed: boolean;
  /** Individual assertion results. */
  assertions: EvalAssertionResult[];
  /** Actual response from the agent. */
  actual: EvalActualResponse;
  /** Duration including setup. */
  durationMs: number;
  /** Error if the test itself failed to run. */
  error?: string;
}

/** Result of a full evaluation suite run. */
export interface EvalSuiteResult {
  /** Suite name / file path. */
  name: string;
  /** Individual test results. */
  results: EvalTestResult[];
  /** Summary statistics. */
  summary: EvalSummary;
  /** Total suite duration in ms. */
  durationMs: number;
}

/** Summary statistics for an evaluation run. */
export interface EvalSummary {
  total: number;
  passed: number;
  failed: number;
  errors: number;
  /** Pass rate as a fraction (0-1). */
  passRate: number;
  /** Per-metric pass rates. */
  metricPassRates: Record<string, { passed: number; total: number; rate: number }>;
}

// ─── Evaluation Suite File Format ─────────────────────────────

/**
 * JSON file format for evaluation suites.
 *
 * Files use the convention: <agent-id>.eval.json
 * Compatible with vitest for CI integration.
 */
export interface EvalSuiteFile {
  /** Suite name. */
  name: string;
  /** Optional description. */
  description?: string;
  /** Default agent ID for all tests (can be overridden per test). */
  defaultAgentId?: string;
  /** Default timeout for all tests. */
  defaultTimeoutMs?: number;
  /** Test cases. */
  tests: EvalTestCaseJSON[];
}

/**
 * JSON-serializable test case (no functions).
 * The `custom` assertion from EvalTestCase is not available in JSON format.
 */
export interface EvalTestCaseJSON {
  name: string;
  description?: string;
  tags?: string[];
  agentId?: string;
  input: EvalInput;
  expected: {
    content?: ContentMatcher;
    toolCalls?: ExpectedToolCall[];
    metadata?: Record<string, unknown>;
    safety?: SafetyExpectation;
  };
  timeoutMs?: number;
}
