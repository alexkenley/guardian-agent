import { describe, expect, it } from 'vitest';
import type { ChatResponse } from '../llm/types.js';
import {
  IntentGateway,
  attachPreRoutedIntentGatewayMetadata,
  detachPreRoutedIntentGatewayMetadata,
  readPreRoutedIntentGatewayMetadata,
  shouldReusePreRoutedIntentGateway,
  shouldReusePreRoutedIntentGatewayForContent,
  toIntentGatewayClientMetadata,
} from './intent-gateway.js';

describe('IntentGateway', () => {
  it('parses a tool-called structured intent decision', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Create an automation called Browser Read Smoke. Do not schedule it yet.',
        channel: 'web',
      },
      async () => ({
        content: '',
        toolCalls: [{
          id: 'call-1',
          name: 'route_intent',
          arguments: JSON.stringify({
            route: 'automation_authoring',
            confidence: 'high',
            operation: 'create',
            summary: 'Creates a new automation definition.',
            automationName: 'Browser Read Smoke',
            manualOnly: true,
            scheduled: false,
          }),
        }],
        model: 'test-model',
        finishReason: 'tool_calls',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('automation_authoring');
    expect(result.decision.operation).toBe('create');
    expect(result.decision.simpleVsComplex).toBe('complex');
    expect(result.decision.entities.automationName).toBe('Browser Read Smoke');
    expect(result.decision.entities.manualOnly).toBe(true);
    expect(result.model).toBe('test-model');
  });

  it('falls back to parsing JSON content when no tool call is present', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Delete Browser Read Smoke from the automations page.',
        channel: 'web',
      },
      async () => ({
        content: JSON.stringify({
          route: 'automation_control',
          confidence: 'high',
          operation: 'delete',
          summary: 'Deletes an existing automation definition.',
          automationName: 'Browser Read Smoke',
          uiSurface: 'automations',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('automation_control');
    expect(result.decision.operation).toBe('delete');
    expect(result.decision.entities.uiSurface).toBe('automations');
  });

  it('repairs malformed tool-call JSON arguments before normalizing the decision', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Create an automation called Browser Read Smoke. Do not schedule it yet.',
        channel: 'web',
      },
      async () => ({
        content: '',
        toolCalls: [{
          id: 'call-1',
          name: 'route_intent',
          arguments: [
            '{',
            '  "route": "automation_authoring",',
            '  "confidence": "high",',
            '  "operation": "create",',
            '  "summary": "Creates a new automation definition.",',
            '  "automationName": "Browser Read Smoke",',
            '}',
          ].join('\n'),
        }],
        model: 'test-model',
        finishReason: 'tool_calls',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('automation_authoring');
    expect(result.decision.operation).toBe('create');
    expect(result.decision.entities.automationName).toBe('Browser Read Smoke');
  });

  it('captures rename metadata for existing automation updates', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Rename Browser Read Smoke to Browser Read Smoke Daily.',
        channel: 'web',
      },
      async () => ({
        content: JSON.stringify({
          route: 'automation_control',
          confidence: 'high',
          operation: 'update',
          summary: 'Renames an existing automation.',
          automationName: 'Browser Read Smoke',
          newAutomationName: 'Browser Read Smoke Daily',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('automation_control');
    expect(result.decision.operation).toBe('update');
    expect(result.decision.entities.automationName).toBe('Browser Read Smoke');
    expect(result.decision.entities.newAutomationName).toBe('Browser Read Smoke Daily');
  });

  it('detects explicit remote sandbox execution requests', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Run pwd in the remote sandbox for this workspace.',
        channel: 'web',
      },
      async () => ({
        content: JSON.stringify({
          route: 'coding_task',
          confidence: 'high',
          operation: 'run',
          summary: 'Runs pwd in the remote sandbox.',
          codingRemoteExecRequested: true,
          command: 'pwd',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('coding_task');
    expect(result.decision.operation).toBe('run');
    expect(result.decision.entities.codingRemoteExecRequested).toBe(true);
    expect(result.decision.entities.command).toBe('pwd');
    expect(result.decision.entities.sessionTarget).toBeUndefined();
    expect(result.decision.preferredTier).toBe('external');
  });

  it('returns an unknown decision when the model response is not structured', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Open https://example.com and show me the links.',
        channel: 'cli',
      },
      async () => ({
        content: 'I think this is probably a browser task.',
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('unknown');
    expect(result.decision.confidence).toBe('low');
  });

  it('recovers explicit repo file review requests when the model response is not structured', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Inspect src/runtime/intent-gateway.ts, src/runtime/execution-profiles.ts, src/runtime/pending-actions.ts, and src/runtime/dashboard-dispatch.ts for approval-bypass or privilege-escalation risks. Cite exact file paths and give the highest-risk issue first.',
        channel: 'web',
      },
      async () => ({
        content: 'This looks like a code review request over runtime files.',
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('coding_task');
    expect(result.decision.operation).toBe('inspect');
    expect(result.decision.executionClass).toBe('repo_grounded');
    expect(result.decision.requiresRepoGrounding).toBe(true);
    expect(result.decision.expectedContextPressure).toBe('high');
    expect(result.decision.preferredAnswerPath).toBe('chat_synthesis');
  });

  it('retries with a JSON-only fallback when the tool-call gateway path throws', async () => {
    const gateway = new IntentGateway();
    let callCount = 0;

    const result = await gateway.classify(
      {
        content: 'What coding session am I on?',
        channel: 'web',
      },
      async (_messages, options) => {
        callCount += 1;
        if (callCount === 1) {
          expect(options?.tools?.[0]?.name).toBe('route_intent');
          throw new Error('ollama api error: failed to format route_intent tool call');
        }

        expect(options?.tools).toBeUndefined();
        return {
          content: JSON.stringify({
            route: 'coding_session_control',
            confidence: 'high',
            operation: 'inspect',
            summary: 'Inspects the currently attached coding workspace session.',
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      },
    );

    expect(callCount).toBe(2);
    expect(result.mode).toBe('json_fallback');
    expect(result.decision.route).toBe('coding_session_control');
    expect(result.decision.operation).toBe('inspect');
  });

  it('uses the route-only fallback when the full JSON fallback still returns unstructured content', async () => {
    const gateway = new IntentGateway();
    let callCount = 0;

    const result = await gateway.classify(
      {
        content: 'Open https://example.com and show me the links.',
        channel: 'web',
      },
      async (_messages, options) => {
        callCount += 1;
        if (callCount === 1) {
          expect(options?.tools?.[0]?.name).toBe('route_intent');
          throw new Error('ollama api error: failed to format route_intent tool call');
        }
        if (callCount === 2) {
          expect(options?.responseFormat).toEqual({ type: 'json_object' });
          return {
            content: 'I am not sure.',
            model: 'test-model',
            finishReason: 'stop',
          } satisfies ChatResponse;
        }

        expect(options?.responseFormat).toEqual({ type: 'json_object' });
        return {
          content: JSON.stringify({
            route: 'browser_task',
            confidence: 'medium',
            operation: 'navigate',
            summary: 'Navigates to the requested URL and inspects links.',
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      },
    );

    expect(callCount).toBe(3);
    expect(result.mode).toBe('route_only_fallback');
    expect(result.decision.route).toBe('browser_task');
    expect(result.decision.operation).toBe('navigate');
  });

  it('recovers malformed route-only fallback JSON so workload-derived routing stays available', async () => {
    const gateway = new IntentGateway();
    let callCount = 0;

    const result = await gateway.classify(
      {
        content: 'Act as my executive assistant and brief me on what I should do first today.',
        channel: 'web',
      },
      async (_messages, options) => {
        callCount += 1;
        if (callCount === 1) {
          expect(options?.tools?.[0]?.name).toBe('route_intent');
          throw new Error('ollama api error: failed to format route_intent tool call');
        }
        if (callCount === 2) {
          expect(options?.responseFormat).toEqual({ type: 'json_object' });
          return {
            content: 'I am not sure.',
            model: 'test-model',
            finishReason: 'stop',
          } satisfies ChatResponse;
        }

        expect(options?.responseFormat).toEqual({ type: 'json_object' });
        return {
          content: [
            '{',
            '  "route": "personal_assistant_task",',
            '  "operation": "inspect",',
            '  "confidence": "high",',
            '  "summary": "Prepares a daily executive briefing.",',
            '  "turnRelation": "new_request",',
            '  "resolution": "ready"',
          ].join('\n'),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      },
    );

    expect(callCount).toBe(3);
    expect(result.mode).toBe('route_only_fallback');
    expect(result.available).toBe(true);
    expect(result.decision.route).toBe('personal_assistant_task');
    expect(result.decision.operation).toBe('inspect');
    expect(result.decision.executionClass).toBe('direct_assistant');
    expect(result.decision.preferredTier).toBe('local');
    expect(result.decision.preferredAnswerPath).toBe('direct');
  });

  it('synthesizes planned steps for multi-step filesystem work on unstructured fallback paths', async () => {
    const gateway = new IntentGateway();
    let callCount = 0;

    const result = await gateway.classify(
      {
        content: 'Write the current date and time to tmp/manual-web/current-time.txt. Search src/runtime for planned_steps. Write a short summary to tmp/manual-web/planned-steps-summary.txt.',
        channel: 'web',
      },
      async (_messages, options) => {
        callCount += 1;
        if (callCount === 1) {
          expect(options?.tools?.[0]?.name).toBe('route_intent');
          throw new Error('ollama api error: failed to format route_intent tool call');
        }
        expect(options?.responseFormat).toEqual({ type: 'json_object' });
        return {
          content: 'I am not sure.',
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      },
    );

    expect(callCount).toBe(2);
    expect(result.mode).toBe('json_fallback');
    expect(result.decision.plannedSteps).toEqual([
      expect.objectContaining({ kind: 'write', summary: 'Write the current date and time to tmp/manual-web/current-time.txt.' }),
      expect.objectContaining({ kind: 'search', summary: 'Search src/runtime for planned_steps.', dependsOn: ['step_1'] }),
      expect.objectContaining({ kind: 'write', summary: 'Write a short summary to tmp/manual-web/planned-steps-summary.txt.', dependsOn: ['step_2'] }),
    ]);
  });

  it('keeps exact-file repo inspection modifiers inside the synthesized answer contract on fallback paths', async () => {
    const gateway = new IntentGateway();
    let callCount = 0;

    const result = await gateway.classify(
      {
        content: 'Inspect this repo and tell me which files and functions or types now define the delegated worker completion contract. Cite exact file names and symbol names. Do not edit anything.',
        channel: 'web',
      },
      async (_messages, options) => {
        callCount += 1;
        if (callCount === 1) {
          expect(options?.tools?.[0]?.name).toBe('route_intent');
          throw new Error('ollama api error: failed to format route_intent tool call');
        }
        expect(options?.responseFormat).toEqual({ type: 'json_object' });
        return {
          content: 'I am not sure.',
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      },
    );

    expect(callCount).toBe(2);
    expect(result.mode).toBe('json_fallback');
    expect(result.decision.requireExactFileReferences).toBe(true);
    expect(result.decision.plannedSteps).toEqual([
      expect.objectContaining({
        kind: 'search',
        summary: 'Inspect the relevant repo files and collect grounded repo evidence.',
        required: true,
      }),
      expect.objectContaining({
        kind: 'answer',
        summary: 'Answer with exact file names, file paths, and symbol names grounded in the repo evidence.',
        required: true,
        dependsOn: ['step_1'],
      }),
    ]);
  });

  it('uses the request preview for unstructured recovery summaries and keeps recovery diagnostics out of client metadata', async () => {
    const gateway = new IntentGateway();
    const request = 'Use the external path C:\\tmp\\manual-check.txt.';
    let callCount = 0;

    const result = await gateway.classify(
      {
        content: request,
        channel: 'web',
      },
      async (_messages, options) => {
        callCount += 1;
        if (callCount === 1) {
          expect(options?.tools?.[0]?.name).toBe('route_intent');
          throw new Error('ollama api error: failed to format route_intent tool call');
        }
        expect(options?.responseFormat).toEqual({ type: 'json_object' });
        return {
          content: 'I am not sure.',
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      },
    );

    expect(callCount).toBe(2);
    expect(result.mode).toBe('json_fallback');
    expect(result.decision.route).not.toBe('unknown');
    expect(result.decision.summary).toBe(request);
    expect(typeof result.decision.recoveryReason).toBe('string');
    expect(result.decision.recoveryReason).not.toBe(request);

    const metadata = attachPreRoutedIntentGatewayMetadata(undefined, result);
    const restored = readPreRoutedIntentGatewayMetadata(metadata);
    expect(restored?.decision.summary).toBe(request);
    expect(restored?.decision.recoveryReason).toBe(result.decision.recoveryReason);
    expect(toIntentGatewayClientMetadata(restored)).not.toHaveProperty('recoveryReason');
  });

  it('keeps explicit complex-planning requests on the JSON fallback path', async () => {
    const gateway = new IntentGateway();
    const request = 'Use your complex-planning path for this request. In tmp/manual-dag-smoke, create risks.txt, controls.txt, and gaps.txt with 3 short bullet points each about brokered agent isolation. Then create summary.md that turns them into a markdown table plus a final recommendation paragraph. When you finish, include the DAG plan JSON you executed.';
    let callCount = 0;

    const result = await gateway.classify(
      {
        content: request,
        channel: 'web',
      },
      async (messages, options) => {
        callCount += 1;
        if (callCount === 1) {
          expect(options?.tools?.[0]?.name).toBe('route_intent');
          throw new Error('ollama api error: failed to format route_intent tool call');
        }

        expect(options?.tools).toBeUndefined();
        expect(options?.responseFormat).toEqual({ type: 'json_object' });
        expect(messages[0]?.content).toContain('complex_planning_task');
        expect(messages[0]?.content).toContain('planner path');
        return {
          content: JSON.stringify({
            route: 'complex_planning_task',
            confidence: 'high',
            operation: 'run',
            summary: 'Uses the brokered DAG planner path to create the requested files and summary.',
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      },
    );

    expect(callCount).toBe(2);
    expect(result.mode).toBe('json_fallback');
    expect(result.decision.route).toBe('complex_planning_task');
    expect(result.decision.operation).toBe('run');
    expect(result.decision.executionClass).toBe('tool_orchestration');
    expect(result.decision.preferredTier).toBe('external');
    expect(result.decision.requiresToolSynthesis).toBe(true);
    expect(result.decision.expectedContextPressure).toBe('high');
    expect(result.decision.simpleVsComplex).toBe('complex');
    expect(result.decision.preferredAnswerPath).toBe('chat_synthesis');
  });

  it('uses the route-only fallback for explicit complex-planning requests when the JSON fallback throws', async () => {
    const gateway = new IntentGateway();
    const request = 'Use your complex-planning path for this request. In tmp/manual-dag-smoke, create risks.txt, controls.txt, and gaps.txt with 3 short bullet points each about brokered agent isolation. Then create summary.md that turns them into a markdown table plus a final recommendation paragraph. When you finish, include the DAG plan JSON you executed.';
    let callCount = 0;

    const result = await gateway.classify(
      {
        content: request,
        channel: 'web',
      },
      async (messages, options) => {
        callCount += 1;
        if (callCount === 1) {
          expect(options?.tools?.[0]?.name).toBe('route_intent');
          throw new Error('ollama api error: failed to format route_intent tool call');
        }
        if (callCount === 2) {
          expect(options?.responseFormat).toEqual({ type: 'json_object' });
          expect(messages[0]?.content).toContain('complex_planning_task');
          throw new Error('ollama api error: failed to produce JSON fallback output');
        }

        expect(options?.tools).toBeUndefined();
        expect(options?.responseFormat).toEqual({ type: 'json_object' });
        expect(messages[0]?.content).toContain('complex_planning_task');
        expect(messages[0]?.content).toContain('planner path');
        return {
          content: JSON.stringify({
            route: 'complex_planning_task',
            confidence: 'medium',
            operation: 'run',
            summary: 'Uses the planner path for this brokered DAG request.',
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      },
    );

    expect(callCount).toBe(3);
    expect(result.mode).toBe('route_only_fallback');
    expect(result.decision.route).toBe('complex_planning_task');
    expect(result.decision.operation).toBe('run');
    expect(result.decision.executionClass).toBe('tool_orchestration');
    expect(result.decision.requiresToolSynthesis).toBe(true);
    expect(result.decision.preferredAnswerPath).toBe('chat_synthesis');
  });

  it('repairs explicit complex-planning requests when fallback output drifts to filesystem_task', async () => {
    const gateway = new IntentGateway();
    const request = 'Use your complex-planning path for this request. In tmp/manual-dag-smoke, create risks.txt, controls.txt, and gaps.txt with 3 short bullet points each about brokered agent isolation. Then create summary.md that turns them into a markdown table plus a final recommendation paragraph. When you finish, include the DAG plan JSON you executed.';
    let callCount = 0;

    const result = await gateway.classify(
      {
        content: request,
        channel: 'web',
      },
      async (_messages, options) => {
        callCount += 1;
        if (callCount === 1) {
          expect(options?.tools?.[0]?.name).toBe('route_intent');
          throw new Error('ollama api error: failed to format route_intent tool call');
        }

        expect(options?.tools).toBeUndefined();
        expect(options?.responseFormat).toEqual({ type: 'json_object' });
        return {
          content: JSON.stringify({
            route: 'filesystem_task',
            confidence: 'medium',
            operation: 'create',
            summary: 'Creates the requested files in tmp/manual-dag-smoke.',
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      },
    );

    expect(callCount).toBe(2);
    expect(result.mode).toBe('json_fallback');
    expect(result.decision.route).toBe('complex_planning_task');
    expect(result.decision.operation).toBe('run');
    expect(result.decision.executionClass).toBe('tool_orchestration');
    expect(result.decision.preferredTier).toBe('external');
    expect(result.decision.requiresRepoGrounding).toBe(false);
    expect(result.decision.requiresToolSynthesis).toBe(true);
    expect(result.decision.expectedContextPressure).toBe('high');
    expect(result.decision.preferredAnswerPath).toBe('chat_synthesis');
  });

  it('infers coding backend metadata from a minimal structured fallback decision', async () => {
    const gateway = new IntentGateway();

    const result = await gateway.classify(
      {
        content: 'Use Codex in the Test Tactical Game App workspace to create a smoke test file.',
        channel: 'web',
      },
      async (_messages, options) => {
        if (options?.tools?.length) {
          throw new Error('ollama api error: failed to format route_intent tool call');
        }

        return {
          content: JSON.stringify({
            route: 'coding_task',
            confidence: 'medium',
            operation: 'create',
            summary: 'Creates a smoke test file in the requested workspace.',
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      },
    );

    expect(result.decision.route).toBe('coding_task');
    expect(result.decision.operation).toBe('create');
    expect(result.decision.entities.codingBackend).toBe('codex');
    expect(result.decision.entities.codingBackendRequested).toBe(true);
    expect(result.decision.entities.sessionTarget).toBe('Test Tactical Game App');
  });

  it('recovers explicit coding-backend workspace requests from an unstructured gateway response', async () => {
    const gateway = new IntentGateway();

    const result = await gateway.classify(
      {
        content: 'Use Codex in the Test Tactical Game App coding workspace to create a smoke test file.',
        channel: 'web',
      },
      async () => ({
        content: 'I think this is a coding request.',
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.available).toBe(true);
    expect(result.decision.route).toBe('coding_task');
    expect(result.decision.operation).toBe('create');
    expect(result.decision.entities.codingBackend).toBe('codex');
    expect(result.decision.entities.codingBackendRequested).toBe(true);
    expect(result.decision.entities.sessionTarget).toBe('Test Tactical Game App');
  });

  it('recovers explicit coding-backend requests when the user says "use the Codex coding assistant"', async () => {
    const gateway = new IntentGateway();

    const result = await gateway.classify(
      {
        content: 'In the current attached coding session, use the Codex coding assistant to run the unit tests for the tools executor by executing npm test -- src/tools/executor.test.ts.',
        channel: 'web',
      },
      async () => ({
        content: 'This looks like coding work, but I need approval first.',
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.available).toBe(true);
    expect(result.decision.route).toBe('coding_task');
    expect(result.decision.operation).toBe('run');
    expect(result.decision.entities.codingBackend).toBe('codex');
    expect(result.decision.entities.codingBackendRequested).toBe(true);
    expect(result.decision.entities.sessionTarget).toBeUndefined();
    expect(result.decision.preferredAnswerPath).toBe('tool_loop');
  });

  it('recovers explicit code-test execution requests from an unstructured gateway response without requiring an external backend', async () => {
    const gateway = new IntentGateway();

    const result = await gateway.classify(
      {
        content: 'In the current attached coding session, run the unit tests for the tools executor by executing npm test -- src/tools/executor.test.ts.',
        channel: 'cli',
      },
      async () => ({
        content: 'This seems like coding work.',
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.available).toBe(true);
    expect(result.decision.route).toBe('coding_task');
    expect(result.decision.operation).toBe('run');
    expect(result.decision.entities.codingBackend).toBeUndefined();
    expect(result.decision.entities.sessionTarget).toBeUndefined();
    expect(result.decision.requiresRepoGrounding).toBe(true);
    expect(result.decision.preferredAnswerPath).toBe('tool_loop');
  });

  it('recovers explicit scratch-file create requests with .txt paths into the filesystem lane', async () => {
    const gateway = new IntentGateway();

    const result = await gateway.classify(
      {
        content: 'Also create tmp/followup-queue-test.txt listing the top 3 files you consulted.',
        channel: 'web',
      },
      async () => ({
        content: '{',
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.available).toBe(true);
    expect(result.decision.route).toBe('filesystem_task');
    expect(result.decision.operation).toBe('create');
    expect(result.decision.entities.path).toBe('tmp/followup-queue-test.txt');
    expect(result.decision.requiresRepoGrounding).toBe(true);
    expect(result.decision.preferredAnswerPath).toBe('tool_loop');
  });

  it('preserves unstructured missing-detail questions as clarification blockers instead of ready filesystem work', async () => {
    const gateway = new IntentGateway();

    const result = await gateway.classify(
      {
        content: 'Please create an empty file called brokered-test.txt in the requested external directory.',
        channel: 'web',
      },
      async () => ({
        content: 'I need the exact external path before I can request approval. Please tell me which directory or full file path you want me to use for brokered-test.txt.',
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.available).toBe(true);
    expect(result.decision.route).toBe('filesystem_task');
    expect(result.decision.operation).toBe('create');
    expect(result.decision.resolution).toBe('needs_clarification');
    expect(result.decision.missingFields).toContain('path');
    expect(result.decision.summary).toContain('exact external path');
  });

  it('drops generic "current attached" session targets from structured gateway output', async () => {
    const gateway = new IntentGateway();

    const result = await gateway.classify(
      {
        content: 'In the current attached coding session, use the Codex coding assistant to run the unit tests for the tools executor by executing npm test -- src/tools/executor.test.ts.',
        channel: 'cli',
      },
      async () => ({
        content: JSON.stringify({
          route: 'coding_task',
          operation: 'run',
          confidence: 'high',
          resolution: 'ready',
          sessionTarget: 'current attached',
          codingBackend: 'codex',
          codingBackendRequested: true,
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.available).toBe(true);
    expect(result.decision.route).toBe('coding_task');
    expect(result.decision.entities.codingBackend).toBe('codex');
    expect(result.decision.entities.sessionTarget).toBeUndefined();
  });

  it('recovers local Second Brain calendar reads from an unstructured gateway response', async () => {
    const gateway = new IntentGateway();

    const result = await gateway.classify(
      {
        content: 'List my calendar entries for the next seven days.',
        channel: 'telegram',
      },
      async () => ({
        content: 'This looks like a calendar request.',
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.available).toBe(true);
    expect(result.decision.route).toBe('personal_assistant_task');
    expect(result.decision.operation).toBe('read');
    expect(result.decision.entities.personalItemType).toBe('calendar');
    expect(result.decision.entities.calendarTarget).toBe('local');
    expect(result.decision.entities.calendarWindowDays).toBe(7);
  });

  it('converts shadow decisions into client-safe metadata', () => {
    const metadata = toIntentGatewayClientMetadata({
      mode: 'primary',
      available: true,
      model: 'test-model',
      latencyMs: 17,
      decision: {
        route: 'ui_control',
        confidence: 'medium',
        operation: 'navigate',
        summary: 'Refers to a Guardian page.',
        turnRelation: 'new_request',
        resolution: 'ready',
        missingFields: [],
        provenance: {
          route: 'classifier.primary',
          operation: 'classifier.primary',
        },
        entities: {
          uiSurface: 'automations',
        },
      },
    });

    expect(metadata).toMatchObject({
      mode: 'primary',
      model: 'test-model',
      route: 'ui_control',
      operation: 'navigate',
      provenance: {
        route: 'classifier.primary',
      },
    });
  });

  it('supports broader direct-action routes beyond browser and automation', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Search the web for the latest Playwright MCP news.',
        channel: 'cli',
      },
      async () => ({
        content: '',
        toolCalls: [{
          id: 'call-2',
          name: 'route_intent',
          arguments: JSON.stringify({
            route: 'search_task',
            confidence: 'high',
            operation: 'search',
            summary: 'Performs a generic web search.',
            query: 'latest Playwright MCP news',
          }),
        }],
        model: 'test-model',
        finishReason: 'tool_calls',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('search_task');
    expect(result.decision.operation).toBe('search');
    expect(result.decision.entities.query).toBe('latest Playwright MCP news');
  });

  it('derives workload metadata when the model omits the new execution fields', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Search the repo for "ollama_cloud" and tell me which files define its routing.',
        channel: 'web',
      },
      async () => ({
        content: JSON.stringify({
          route: 'coding_task',
          confidence: 'high',
          operation: 'search',
          summary: 'Search the attached repo for routing references.',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.executionClass).toBe('repo_grounded');
    expect(result.decision.preferredTier).toBe('external');
    expect(result.decision.requiresRepoGrounding).toBe(true);
    expect(result.decision.requiresToolSynthesis).toBe(false);
    expect(result.decision.expectedContextPressure).toBe('medium');
    expect(result.decision.preferredAnswerPath).toBe('direct');
    expect(result.decision.provenance).toMatchObject({
      executionClass: 'derived.workload',
      preferredTier: 'derived.workload',
      requiresRepoGrounding: 'derived.workload',
      requiresToolSynthesis: 'derived.workload',
      expectedContextPressure: 'derived.workload',
      preferredAnswerPath: 'derived.workload',
    });
  });

  it('parses personal assistant routes and item types', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Show my tasks for today.',
        channel: 'web',
      },
      async () => ({
        content: '',
        toolCalls: [{
          id: 'call-personal-1',
          name: 'route_intent',
          arguments: JSON.stringify({
            route: 'personal_assistant_task',
            confidence: 'high',
            operation: 'read',
            summary: 'Reads the user task list from Second Brain.',
            personalItemType: 'task',
          }),
        }],
        model: 'test-model',
        finishReason: 'tool_calls',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('personal_assistant_task');
    expect(result.decision.operation).toBe('read');
    expect(result.decision.entities.personalItemType).toBe('task');
    expect(result.decision.simpleVsComplex).toBe('complex');
  });

  it('derives a simpleVsComplex signal for simple direct-assistant turns when the model omits it', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Give me a concise plan for organizing my week.',
        channel: 'web',
      },
      async () => ({
        content: JSON.stringify({
          route: 'general_assistant',
          confidence: 'high',
          operation: 'inspect',
          summary: 'Provides a concise planning answer.',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('general_assistant');
    expect(result.decision.simpleVsComplex).toBe('simple');
  });

  it('repairs a misrouted multiline task create into personal assistant work', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Create a task called "Send Harbor launch review deck" due   \n  April 9, 2026 at 4 PM.',
        channel: 'web',
      },
      async () => ({
        content: '',
        toolCalls: [{
          id: 'call-personal-repair-task-1',
          name: 'route_intent',
          arguments: JSON.stringify({
            route: 'general_assistant',
            confidence: 'medium',
            operation: 'create',
            summary: 'Creates something for the user.',
          }),
        }],
        model: 'test-model',
        finishReason: 'tool_calls',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('personal_assistant_task');
    expect(result.decision.operation).toBe('create');
    expect(result.decision.entities.personalItemType).toBe('task');
  });

  it('repairs a misrouted multiline library save into personal assistant work', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Save this link in my library with title "Harbor launch checklist", url "https://example.com", and notes "Reference for the\nHarbor launch review."',
        channel: 'web',
      },
      async () => ({
        content: '',
        toolCalls: [{
          id: 'call-personal-repair-library-1',
          name: 'route_intent',
          arguments: JSON.stringify({
            route: 'unknown',
            confidence: 'low',
            operation: 'save',
            summary: 'Unsure.',
          }),
        }],
        model: 'test-model',
        finishReason: 'tool_calls',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('personal_assistant_task');
    expect(result.decision.operation).toBe('save');
    expect(result.decision.entities.personalItemType).toBe('library');
  });

  it('repairs a misrouted library query into a direct Second Brain read with a search query', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Show my library items about Harbor.',
        channel: 'web',
      },
      async () => ({
        content: '',
        toolCalls: [{
          id: 'call-personal-repair-library-read-1',
          name: 'route_intent',
          arguments: JSON.stringify({
            route: 'general_assistant',
            confidence: 'medium',
            operation: 'unknown',
            summary: 'Unsure.',
          }),
        }],
        model: 'test-model',
        finishReason: 'tool_calls',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('personal_assistant_task');
    expect(result.decision.operation).toBe('read');
    expect(result.decision.entities.personalItemType).toBe('library');
    expect(result.decision.entities.query).toBe('Harbor');
  });

  it('does not repair explicit filesystem file creation requests into Second Brain note work', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Create an empty file called note-a.txt in D:\\Temp\\guardian-phase1-test\\phase1-fresh-a.',
        channel: 'web',
      },
      async () => ({
        content: JSON.stringify({
          route: 'general_assistant',
          confidence: 'medium',
          operation: 'create',
          summary: 'Creates something for the user.',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).not.toBe('personal_assistant_task');
    expect(result.decision.entities.personalItemType).not.toBe('note');
  });

  it('repairs a misrouted person lookup into a direct Second Brain read with a search query', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Find the person "Jordan Lee" in my Second Brain.',
        channel: 'web',
      },
      async () => ({
        content: JSON.stringify({
          route: 'unknown',
          confidence: 'low',
          operation: 'unknown',
          summary: 'Unsure.',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('personal_assistant_task');
    expect(result.decision.operation).toBe('search');
    expect(result.decision.entities.personalItemType).toBe('person');
    expect(result.decision.entities.query).toBe('Jordan Lee');
  });

  it('captures local Second Brain calendar targeting for unqualified calendar CRUD', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Create a calendar entry for tomorrow at 3 PM called Dentist.',
        channel: 'web',
      },
      async () => ({
        content: '',
        toolCalls: [{
          id: 'call-personal-calendar-1',
          name: 'route_intent',
          arguments: JSON.stringify({
            route: 'personal_assistant_task',
            confidence: 'high',
            operation: 'create',
            summary: 'Creates a local Second Brain calendar entry.',
            personalItemType: 'calendar',
            calendarTarget: 'local',
          }),
        }],
        model: 'test-model',
        finishReason: 'tool_calls',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('personal_assistant_task');
    expect(result.decision.operation).toBe('create');
    expect(result.decision.entities.personalItemType).toBe('calendar');
    expect(result.decision.entities.calendarTarget).toBe('local');
  });

  it('parses explicit Second Brain routine creation requests as personal assistant work', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Create the Pre-Meeting Brief routine in Second Brain.',
        channel: 'web',
      },
      async () => ({
        content: '',
        toolCalls: [{
          id: 'call-personal-routine-1',
          name: 'route_intent',
          arguments: JSON.stringify({
            route: 'personal_assistant_task',
            confidence: 'high',
            operation: 'create',
            summary: 'Creates a built-in Second Brain routine.',
            personalItemType: 'routine',
          }),
        }],
        model: 'test-model',
        finishReason: 'tool_calls',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('personal_assistant_task');
    expect(result.decision.operation).toBe('create');
    expect(result.decision.entities.personalItemType).toBe('routine');
  });

  it('repairs missing personalItemType for natural-language scheduled review creation requests', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Create a review for Board prep every Friday at 4 pm.',
        channel: 'web',
      },
      async () => ({
        content: JSON.stringify({
          route: 'personal_assistant_task',
          confidence: 'high',
          operation: 'create',
          summary: 'Creates a scheduled review routine.',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('personal_assistant_task');
    expect(result.decision.operation).toBe('create');
    expect(result.decision.entities.personalItemType).toBe('routine');
  });

  it('repairs missing personalItemType for natural-language task creation requests', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Create a task called "Send Harbor launch review deck" due April 9, 2026 at 4 PM.',
        channel: 'web',
      },
      async () => ({
        content: JSON.stringify({
          route: 'personal_assistant_task',
          confidence: 'high',
          operation: 'create',
          summary: 'Creates a local task.',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('personal_assistant_task');
    expect(result.decision.operation).toBe('create');
    expect(result.decision.entities.personalItemType).toBe('task');
  });

  it('repairs missing personalItemType for natural-language note saves', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Save a note titled "Harbor launch review notes" with content "Finalize launch metrics."',
        channel: 'web',
      },
      async () => ({
        content: JSON.stringify({
          route: 'personal_assistant_task',
          confidence: 'high',
          operation: 'save',
          summary: 'Saves a local note.',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('personal_assistant_task');
    expect(result.decision.operation).toBe('save');
    expect(result.decision.entities.personalItemType).toBe('note');
  });

  it('repairs missing personalItemType for natural-language library saves', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Save this link in my library with title "Harbor launch checklist", url "https://example.com".',
        channel: 'web',
      },
      async () => ({
        content: JSON.stringify({
          route: 'personal_assistant_task',
          confidence: 'high',
          operation: 'save',
          summary: 'Saves a local library item.',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('personal_assistant_task');
    expect(result.decision.operation).toBe('save');
    expect(result.decision.entities.personalItemType).toBe('library');
  });

  it('repairs misclassified routine follow-up updates away from automation control', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Update that routine to run every Friday at 5 pm.',
        channel: 'web',
      },
      async () => ({
        content: JSON.stringify({
          route: 'automation_control',
          confidence: 'high',
          operation: 'update',
          summary: 'Updates an existing automation.',
          automationName: 'Board prep review',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('personal_assistant_task');
    expect(result.decision.operation).toBe('update');
    expect(result.decision.entities.personalItemType).toBe('routine');
    expect(result.decision.entities.automationName).toBeUndefined();
  });

  it('repairs routine clarification answers back onto the pending Second Brain route', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Friday Board Review',
        channel: 'web',
        pendingAction: {
          id: 'pending-routine-name',
          status: 'pending',
          blockerKind: 'clarification',
          field: 'name',
          route: 'personal_assistant_task',
          operation: 'create',
          prompt: 'What should I call this Second Brain routine?',
          originalRequest: 'Create a review for Board prep every Friday at 4 pm.',
          transferPolicy: 'origin_surface_only',
        },
      },
      async () => ({
        content: JSON.stringify({
          route: 'automation_control',
          confidence: 'high',
          operation: 'update',
          summary: 'Names the thing to update.',
          turnRelation: 'clarification_answer',
          automationName: 'Friday Board Review',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('personal_assistant_task');
    expect(result.decision.turnRelation).toBe('clarification_answer');
    expect(result.decision.operation).toBe('create');
    expect(result.decision.entities.personalItemType).toBe('routine');
    expect(result.decision.provenance).toMatchObject({
      route: 'resolver.clarification',
      operation: 'resolver.clarification',
      entities: {
        personalItemType: 'resolver.personal_assistant',
      },
    });
  });

  it('repairs personal-assistant clarification answers back onto the pending Second Brain person route', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Angela Lee ... phone number 0887 895 687',
        channel: 'web',
        pendingAction: {
          id: 'pending-person-identity',
          status: 'pending',
          blockerKind: 'clarification',
          field: 'person_identity',
          route: 'personal_assistant_task',
          operation: 'create',
          prompt: 'To create a local contact, I need at least a name or email address.',
          originalRequest: 'Create a contact in my Second Brain.',
          transferPolicy: 'origin_surface_only',
        },
      },
      async () => ({
        content: JSON.stringify({
          route: 'general_assistant',
          confidence: 'high',
          operation: 'inspect',
          summary: 'Provides the missing person details.',
          turnRelation: 'clarification_answer',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('personal_assistant_task');
    expect(result.decision.turnRelation).toBe('clarification_answer');
    expect(result.decision.operation).toBe('create');
    expect(result.decision.entities.personalItemType).toBe('person');
  });

  it('repairs missing enabled=false for disabled routine reads from the source request', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Show only my disabled routines.',
        channel: 'web',
      },
      async () => ({
        content: '',
        toolCalls: [{
          id: 'call-personal-routine-read-1',
          name: 'route_intent',
          arguments: JSON.stringify({
            route: 'personal_assistant_task',
            confidence: 'high',
            operation: 'read',
            summary: 'Reads disabled Second Brain routines.',
            personalItemType: 'routine',
          }),
        }],
        model: 'test-model',
        finishReason: 'tool_calls',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('personal_assistant_task');
    expect(result.decision.operation).toBe('read');
    expect(result.decision.entities.personalItemType).toBe('routine');
    expect(result.decision.entities.enabled).toBe(false);
  });

  it('repairs missing personalItemType for explicit routine reads from the source request', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Show my routines again.',
        channel: 'web',
      },
      async () => ({
        content: '',
        toolCalls: [{
          id: 'call-personal-routine-read-2',
          name: 'route_intent',
          arguments: JSON.stringify({
            route: 'personal_assistant_task',
            confidence: 'high',
            operation: 'read',
            summary: 'Reads the same Second Brain list again.',
          }),
        }],
        model: 'test-model',
        finishReason: 'tool_calls',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('personal_assistant_task');
    expect(result.decision.operation).toBe('read');
    expect(result.decision.entities.personalItemType).toBe('routine');
  });

  it('repairs missing routine query from topical routine reads in the source request', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Show only my disabled routines related to follow up.',
        channel: 'web',
      },
      async () => ({
        content: '',
        toolCalls: [{
          id: 'call-personal-routine-read-3',
          name: 'route_intent',
          arguments: JSON.stringify({
            route: 'personal_assistant_task',
            confidence: 'high',
            operation: 'read',
            summary: 'Reads disabled Second Brain routines.',
          }),
        }],
        model: 'test-model',
        finishReason: 'tool_calls',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('personal_assistant_task');
    expect(result.decision.operation).toBe('read');
    expect(result.decision.entities.personalItemType).toBe('routine');
    expect(result.decision.entities.enabled).toBe(false);
    expect(result.decision.entities.query).toBe('follow up');
  });

  it('does not misclassify repo-scoped implementation planning as a Second Brain routine request', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Write an implementation plan for adding archived routines to this app.',
        channel: 'web',
      },
      async () => ({
        content: JSON.stringify({
          route: 'personal_assistant_task',
          confidence: 'low',
          operation: 'create',
          summary: 'Creates a new routine.',
          turnRelation: 'new_request',
          resolution: 'ready',
          personalItemType: 'routine',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('coding_task');
    expect(result.decision.operation).toBe('inspect');
    expect(result.decision.entities.personalItemType).toBeUndefined();
  });

  it('preserves explicit automation creation requests as automation authoring', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Create an automation that checks WHM disk quota every day.',
        channel: 'web',
      },
      async () => ({
        content: JSON.stringify({
          route: 'automation_authoring',
          confidence: 'high',
          operation: 'create',
          summary: 'Creates a new power-user automation.',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('automation_authoring');
    expect(result.decision.operation).toBe('create');
  });

  it('preserves provider metadata for provider-backed personal assistant work', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Prepare me for my next Outlook meeting using the calendar event, recent email, and docs.',
        channel: 'web',
      },
      async () => ({
        content: '',
        toolCalls: [{
          id: 'call-personal-provider-1',
          name: 'route_intent',
          arguments: JSON.stringify({
            route: 'personal_assistant_task',
            confidence: 'high',
            operation: 'inspect',
            summary: 'Prepares a meeting brief using Microsoft 365 context.',
            personalItemType: 'brief',
            emailProvider: 'm365',
          }),
        }],
        model: 'test-model',
        finishReason: 'tool_calls',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('personal_assistant_task');
    expect(result.decision.entities.personalItemType).toBe('brief');
    expect(result.decision.entities.emailProvider).toBe('m365');
  });

  it('preserves explicit provider calendar targets for workspace calendar CRUD', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Delete the event from my Outlook calendar.',
        channel: 'web',
      },
      async () => ({
        content: JSON.stringify({
          route: 'workspace_task',
          confidence: 'high',
          operation: 'delete',
          summary: 'Deletes an event from the Microsoft 365 calendar provider.',
          calendarTarget: 'm365',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('workspace_task');
    expect(result.decision.operation).toBe('delete');
    expect(result.decision.entities.calendarTarget).toBe('m365');
  });

  it('preserves workspace_task for explicit provider CRUD', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Update the SharePoint document for the launch checklist.',
        channel: 'web',
      },
      async () => ({
        content: JSON.stringify({
          route: 'workspace_task',
          confidence: 'high',
          operation: 'update',
          summary: 'Updates an explicit Microsoft 365 provider document.',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('workspace_task');
    expect(result.decision.operation).toBe('update');
  });

  it('preserves AI provider configuration requests as config-scoped provider orchestration', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'List my configured AI providers.',
        channel: 'web',
      },
      async () => ({
        content: JSON.stringify({
          route: 'general_assistant',
          confidence: 'high',
          operation: 'read',
          summary: 'Lists the configured Guardian AI provider profiles.',
          uiSurface: 'config',
          executionClass: 'provider_crud',
          preferredTier: 'external',
          requiresRepoGrounding: false,
          requiresToolSynthesis: true,
          expectedContextPressure: 'medium',
          preferredAnswerPath: 'tool_loop',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('general_assistant');
    expect(result.decision.operation).toBe('read');
    expect(result.decision.entities.uiSurface).toBe('config');
    expect(result.decision.executionClass).toBe('provider_crud');
    expect(result.decision.preferredAnswerPath).toBe('tool_loop');
  });

  it('recovers AI provider inventory requests from unavailable gateway output', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'List my configured AI providers.',
        channel: 'web',
      },
      async () => ({
        content: 'This looks like a settings question.',
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.available).toBe(true);
    expect(result.decision.route).toBe('general_assistant');
    expect(result.decision.operation).toBe('read');
    expect(result.decision.entities.uiSurface).toBe('config');
    expect(result.decision.executionClass).toBe('provider_crud');
    expect(result.decision.preferredTier).toBe('external');
    expect(result.decision.requiresToolSynthesis).toBe(true);
    expect(result.decision.preferredAnswerPath).toBe('tool_loop');
  });

  it('includes file-grounded coding review guidance in the gateway system prompt', async () => {
    const gateway = new IntentGateway();
    let inspectedSystemPrompt = '';

    await gateway.classify(
      {
        content: 'Inspect src/skills/prompt.ts and review the uplift for regressions.',
        channel: 'cli',
      },
      async (messages) => {
        inspectedSystemPrompt = String(messages[0]?.content || '');
        return {
          content: '',
          toolCalls: [{
            id: 'call-coding-review-1',
            name: 'route_intent',
            arguments: JSON.stringify({
              route: 'coding_task',
              confidence: 'high',
              operation: 'inspect',
              summary: 'Reviews a repo-grounded coding change.',
            }),
          }],
          model: 'test-model',
          finishReason: 'tool_calls',
        } satisfies ChatResponse;
      },
    );

    expect(inspectedSystemPrompt).toContain('Prompt profile: full');
    expect(inspectedSystemPrompt).toContain('Requests to inspect, explain, review, or plan changes against specific repo files');
    expect(inspectedSystemPrompt).toContain('Inspect src/skills/prompt.ts and src/chat-agent.ts. Review the uplift for regressions and missing tests.');
  });

  it('uses the compact primary prompt for short flat turns', async () => {
    const gateway = new IntentGateway();
    let inspectedSystemPrompt = '';

    await gateway.classify(
      {
        content: 'Show my notes.',
        channel: 'web',
      },
      async (messages) => {
        inspectedSystemPrompt = String(messages[0]?.content || '');
        return {
          content: '',
          toolCalls: [{
            id: 'call-compact-1',
            name: 'route_intent',
            arguments: JSON.stringify({
              route: 'personal_assistant_task',
              confidence: 'high',
              operation: 'read',
              summary: 'Reads the user notes from Second Brain.',
              personalItemType: 'note',
            }),
          }],
          model: 'test-model',
          finishReason: 'tool_calls',
        } satisfies ChatResponse;
      },
    );

    expect(inspectedSystemPrompt).toContain('Prompt profile: compact');
    expect(inspectedSystemPrompt).toContain('This is the compact primary routing profile for short, flat turns.');
    expect(inspectedSystemPrompt).toContain('Example: "Use Codex to say hello." -> route=coding_task, operation=run, codingBackend=codex, codingBackendRequested=true.');
    expect(inspectedSystemPrompt).not.toContain('Create a contact in my Second Brain named Smoke Test Person with email smoke@example.com.');
  });

  it('keeps short self-contained turns on the compact prompt even with attached-session continuity', async () => {
    const gateway = new IntentGateway();
    let inspectedSystemPrompt = '';

    await gateway.classify(
      {
        content: 'Show my notes.',
        channel: 'web',
        recentHistory: [
          { role: 'user', content: 'Use Codex in the Guardian workspace to investigate the failing build.' },
          { role: 'assistant', content: 'I need approval to run Codex for that coding task.' },
        ],
        continuity: {
          continuityKey: 'shared-tier:owner',
          linkedSurfaceCount: 3,
          focusSummary: 'Attached Guardian coding session with an active investigation.',
          activeExecutionRefs: ['code_session:Guardian'],
        },
      },
      async (messages) => {
        inspectedSystemPrompt = String(messages[0]?.content || '');
        return {
          content: JSON.stringify({
            route: 'personal_assistant_task',
            confidence: 'high',
            operation: 'read',
            summary: 'Reads the user notes from Second Brain.',
            personalItemType: 'note',
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      },
    );

    expect(inspectedSystemPrompt).toContain('Prompt profile: compact');
  });

  it('omits recent-history and continuity thread context for standalone greetings', async () => {
    const gateway = new IntentGateway();
    let capturedUser = '';

    await gateway.classify(
      {
        content: 'Hello',
        channel: 'web',
        recentHistory: [
          { role: 'user', content: 'Use Codex in the Guardian workspace to investigate the failing build.' },
          { role: 'assistant', content: 'I need approval to run Codex for that coding task.' },
        ],
        continuity: {
          continuityKey: 'shared-tier:owner',
          linkedSurfaceCount: 3,
          focusSummary: 'Attached Guardian coding session with an active investigation.',
          lastActionableRequest: 'Use Codex in the Guardian workspace to investigate the failing build.',
          activeExecutionRefs: ['code_session:Guardian'],
        },
      },
      async (messages) => {
        capturedUser = messages[1]?.content ?? '';
        return {
          content: JSON.stringify({
            route: 'general_assistant',
            confidence: 'high',
            operation: 'inspect',
            summary: 'Greets the user.',
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      },
    );

    expect(capturedUser).not.toContain('Recent conversation:');
    expect(capturedUser).not.toContain('Continuity thread context:');
  });

  it('includes explicit Google Workspace and Microsoft 365 split guidance in both gateway prompts', async () => {
    const gateway = new IntentGateway();
    let primaryPrompt = '';
    let fallbackPrompt = '';
    let callCount = 0;

    const result = await gateway.classify(
      {
        content: 'Prepare me for my next Outlook meeting using the calendar event, recent email, and docs.',
        channel: 'web',
      },
      async (messages, options) => {
        callCount += 1;
        if (callCount === 1) {
          primaryPrompt = String(messages[0]?.content || '');
          expect(options?.tools?.[0]?.name).toBe('route_intent');
          throw new Error('force fallback');
        }

        fallbackPrompt = String(messages[0]?.content || '');
        expect(options?.tools).toBeUndefined();
        return {
          content: JSON.stringify({
            route: 'personal_assistant_task',
            confidence: 'high',
            operation: 'inspect',
            summary: 'Prepares a meeting brief using Microsoft 365 context.',
            personalItemType: 'brief',
            emailProvider: 'm365',
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      },
    );

    expect(result.decision.route).toBe('personal_assistant_task');
    expect(primaryPrompt).toContain('Prompt profile: full');
    expect(primaryPrompt).toContain('Prefer personal_assistant_task for meeting prep, follow-up drafting, calendar planning');
    expect(primaryPrompt).toContain('Guardian AI provider profile inventory, model catalog inspection, model routing policy, and AI provider configuration work are not Second Brain tasks.');
    expect(primaryPrompt).toContain('Prefer automation_authoring when the user explicitly asks to create an automation');
    expect(primaryPrompt).toContain('Create the Pre-Meeting Brief routine in Second Brain.');
    expect(primaryPrompt).toContain('Create an automation that checks WHM disk quota every day.');
    expect(primaryPrompt).toContain('Unqualified calendar entry, calendar event, or calendar item create/update/delete requests default to the local Second Brain calendar');
    expect(primaryPrompt).toContain('Example: "Create a calendar entry for tomorrow at 3 PM called Dentist." -> route=personal_assistant_task');
    expect(primaryPrompt).toContain('Example: "Show my notes." -> route=personal_assistant_task, operation=read, personalItemType=note.');
    expect(primaryPrompt).toContain('Example: "Show my library items." -> route=personal_assistant_task, operation=read, personalItemType=library.');
    expect(primaryPrompt).toContain('Example: "Show my library items about Harbor." -> route=personal_assistant_task, operation=read, personalItemType=library, query="Harbor".');
    expect(primaryPrompt).toContain('Example: "Show the contacts in my Second Brain." -> route=personal_assistant_task, operation=read, personalItemType=person.');
    expect(primaryPrompt).toContain('Example: "Find the contact \\"Jordan Lee\\" in my Second Brain." -> route=personal_assistant_task, operation=read, personalItemType=person, query="Jordan Lee".');
    expect(primaryPrompt).toContain('Example: "Show only my disabled routines." -> route=personal_assistant_task, operation=read, personalItemType=routine, enabled=false.');
    expect(primaryPrompt).toContain('Example: "What routines are related to email or inbox processing?" -> route=personal_assistant_task, operation=read, personalItemType=routine, query="email or inbox processing".');
    expect(primaryPrompt).toContain('Example: "Show my calendar events for the next 7 days." -> route=personal_assistant_task, operation=read, personalItemType=calendar, calendarTarget=local, calendarWindowDays=7.');
    expect(primaryPrompt).toContain('Example: "Create a contact in my Second Brain named Smoke Test Person with email smoke@example.com." -> route=personal_assistant_task, operation=create, personalItemType=person.');
    expect(primaryPrompt).toContain('Example: "Prepare me for my next Outlook meeting using the calendar event, recent email, and docs." -> route=personal_assistant_task');
    expect(primaryPrompt).toContain('Example: "List my configured AI providers." -> route=general_assistant, operation=read, uiSurface=config');
    expect(primaryPrompt).toContain('SharePoint');
    expect(fallbackPrompt).toContain('workspace_task means explicit provider CRUD or administration in Google Workspace or Microsoft 365 surfaces');
    expect(fallbackPrompt).toContain('Guardian AI provider profile inventory, model catalogs, model routing policy, and AI provider configuration work are not personal_assistant_task.');
    expect(fallbackPrompt).toContain('Prefer automation_authoring when the user explicitly asks to create an automation or workflow in the Automations system.');
    expect(fallbackPrompt).toContain('Examples: "Add this meeting to my Google Calendar." -> route="workspace_task", operation="create", calendarTarget="gws".');
    expect(fallbackPrompt).toContain('Examples: "Update the SharePoint document for the launch checklist." -> route="workspace_task", operation="update".');
    expect(fallbackPrompt).toContain('Examples: "Check my unread Outlook mail." -> route="email_task", operation="read", emailProvider="m365", mailboxReadMode="unread".');
    expect(fallbackPrompt).toContain('Examples: "Show me the newest five emails in Gmail." -> route="email_task", operation="read", emailProvider="gws", mailboxReadMode="latest".');
    expect(fallbackPrompt).toContain('Examples: "List my configured AI providers." -> route="general_assistant", operation="read", uiSurface="config"');
    expect(fallbackPrompt).toContain('Examples: "Give me a concise plan for organizing my week." -> route="general_assistant", operation="inspect"');
    expect(fallbackPrompt).toContain('Examples: "Show my notes." -> route="personal_assistant_task", operation="read", personalItemType="note".');
    expect(fallbackPrompt).toContain('Examples: "Show my library items." -> route="personal_assistant_task", operation="read", personalItemType="library".');
    expect(fallbackPrompt).toContain('Examples: "Show my library items about Harbor." -> route="personal_assistant_task", operation="read", personalItemType="library", query="Harbor".');
    expect(fallbackPrompt).toContain('Examples: "Show the contacts in my Second Brain." -> route="personal_assistant_task", operation="read", personalItemType="person".');
    expect(fallbackPrompt).toContain('Examples: "Find the contact \\"Jordan Lee\\" in my Second Brain." -> route="personal_assistant_task", operation="read", personalItemType="person", query="Jordan Lee".');
    expect(fallbackPrompt).toContain('Examples: "Show only my disabled routines." -> route="personal_assistant_task", operation="read", personalItemType="routine", enabled=false.');
    expect(fallbackPrompt).toContain('Examples: "What routines are related to email or inbox processing?" -> route="personal_assistant_task", operation="read", personalItemType="routine", query="email or inbox processing".');
    expect(fallbackPrompt).toContain('Examples: "Show my calendar events for the next 7 days." -> route="personal_assistant_task", operation="read", personalItemType="calendar", calendarTarget="local", calendarWindowDays=7.');
    expect(fallbackPrompt).toContain('Examples: "Create a contact in my Second Brain named Smoke Test Person with email smoke@example.com." -> route="personal_assistant_task", operation="create", personalItemType="person".');
  });

  it('preserves explicit cloud tool and profile entities without collapsing to automation control', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Run the cloud tool whm_status using profileId social.',
        channel: 'web',
      },
      async () => ({
        content: '',
        toolCalls: [{
          id: 'call-cloud-1',
          name: 'route_intent',
          arguments: JSON.stringify({
            route: 'general_assistant',
            confidence: 'high',
            operation: 'run',
            summary: 'Runs an explicitly named cloud tool.',
            toolName: 'whm_status',
            profileId: 'social',
          }),
        }],
        model: 'test-model',
        finishReason: 'tool_calls',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).not.toBe('automation_control');
    expect(result.decision.entities.toolName).toBe('whm_status');
    expect(result.decision.entities.profileId).toBe('social');
  });

  it('preserves natural-language WHM status requests as explicit tool/profile entities', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Check the social WHM account status.',
        channel: 'web',
      },
      async () => ({
        content: JSON.stringify({
          route: 'general_assistant',
          confidence: 'high',
          operation: 'inspect',
          summary: 'Checks WHM status for a configured hosting profile.',
          toolName: 'whm_status',
          profileId: 'social',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).not.toBe('automation_control');
    expect(result.decision.entities.toolName).toBe('whm_status');
    expect(result.decision.entities.profileId).toBe('social');
  });

  it('supports memory_task classifications for explicit remember requests', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Remember globally that my test marker is cedar-47.',
        channel: 'web',
      },
      async () => ({
        content: '',
        toolCalls: [{
          id: 'call-memory-1',
          name: 'route_intent',
          arguments: JSON.stringify({
            route: 'memory_task',
            confidence: 'high',
            operation: 'save',
            summary: 'Saves an explicit user memory request.',
          }),
        }],
        model: 'test-model',
        finishReason: 'tool_calls',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('memory_task');
    expect(result.decision.operation).toBe('save');
  });

  it('normalizes placeholder coding backend values away', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Did that backend run finish?',
        channel: 'telegram',
      },
      async () => ({
        content: JSON.stringify({
          route: 'coding_task',
          confidence: 'high',
          operation: 'inspect',
          summary: 'Checks the status of the most recent backend run.',
          turnRelation: 'follow_up',
          codingBackend: 'unknown',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('coding_task');
    expect(result.decision.operation).toBe('inspect');
    expect(result.decision.entities.codingBackend).toBeUndefined();
  });

  it('preserves an explicit session target on coding tasks', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Use Codex in the Test Tactical Game App workspace to create a smoke test file.',
        channel: 'cli',
      },
      async () => ({
        content: JSON.stringify({
          route: 'coding_task',
          confidence: 'high',
          operation: 'create',
          summary: 'Runs Codex in the requested coding workspace.',
          codingBackend: 'codex',
          codingBackendRequested: true,
          sessionTarget: 'Test Tactical Game App workspace',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('coding_task');
    expect(result.decision.entities.codingBackend).toBe('codex');
    expect(result.decision.entities.codingBackendRequested).toBe(true);
    expect(result.decision.entities.sessionTarget).toBe('Test Tactical Game App workspace');
  });

  it('includes guidance that unrelated new requests should not be absorbed by an active pending action', async () => {
    const gateway = new IntentGateway();
    let capturedSystem = '';
    let capturedUser = '';

    await gateway.classify(
      {
        content: 'Check my email.',
        channel: 'web',
        pendingAction: {
          id: 'pending-1',
          status: 'pending',
          blockerKind: 'approval',
          transferPolicy: 'origin_surface_only',
          route: 'coding_task',
          operation: 'run',
          prompt: 'Approval required for a Codex run.',
          originalRequest: 'Use Codex to say hello and confirm you are working.',
        },
      },
      async (messages) => {
        capturedSystem = messages[0]?.content ?? '';
        capturedUser = messages[1]?.content ?? '';
        return {
          content: JSON.stringify({
            route: 'email_task',
            confidence: 'high',
            operation: 'read',
            summary: 'Checks the mailbox.',
            turnRelation: 'new_request',
            resolution: 'needs_clarification',
            missingFields: ['email_provider'],
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      },
    );

    expect(capturedSystem).toContain('An active pending action does not automatically make the next turn a follow_up');
    expect(capturedSystem).toContain('active pending action is approval for a Codex run, then the user says "Check my email."');
    expect(capturedUser).toContain('Pending action context (only relevant if the current turn is actually continuing or resolving it):');
    expect(capturedUser).toContain('transfer policy: origin_surface_only');
  });

  it('includes structured pending-action intent context when available', async () => {
    const gateway = new IntentGateway();
    let capturedUser = '';

    await gateway.classify(
      {
        content: 'It is connected now.',
        channel: 'telegram',
        pendingAction: {
          id: 'pending-google-calendar-auth',
          status: 'pending',
          blockerKind: 'auth',
          route: 'workspace_task',
          operation: 'read',
          summary: 'Lists Google Calendar events for the next 7 days.',
          resolution: 'needs_clarification',
          missingFields: ['provider_auth'],
          provenance: {
            route: 'classifier.primary',
            operation: 'classifier.primary',
            entities: {
              calendarTarget: 'resolver.personal_assistant',
            },
          },
          entities: { calendarTarget: 'gws' },
          prompt: 'Google Workspace is not connected yet. Connect it and then continue.',
          originalRequest: 'List my Google Calendar entries for the next 7 days.',
          transferPolicy: 'linked_surfaces_same_user',
        },
      },
      async (messages) => {
        capturedUser = messages[1]?.content ?? '';
        return {
          content: JSON.stringify({
            route: 'workspace_task',
            confidence: 'medium',
            operation: 'read',
            summary: 'Resumes the explicit Google Calendar read.',
            turnRelation: 'follow_up',
            resolution: 'ready',
            calendarTarget: 'gws',
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      },
    );

    expect(capturedUser).toContain('summary: Lists Google Calendar events for the next 7 days.');
    expect(capturedUser).toContain('resolution: needs_clarification');
    expect(capturedUser).toContain('missing fields: provider_auth');
    expect(capturedUser).toContain('provenance: {"route":"classifier.primary","operation":"classifier.primary","entities":{"calendarTarget":"resolver.personal_assistant"}}');
    expect(capturedUser).toContain('entities: {"calendarTarget":"gws"}');
  });

  it('includes continuity thread context when available', async () => {
    const gateway = new IntentGateway();
    let capturedUser = '';

    await gateway.classify(
      {
        content: 'Did Codex finish that file update?',
        channel: 'cli',
        continuity: {
          continuityKey: 'shared-tier:owner',
          linkedSurfaceCount: 2,
          linkedSurfaces: ['web:chat-main', 'cli:owner'],
          focusSummary: 'Continue the active coding task.',
          lastActionableRequest: 'Use Codex to create the smoke test file.',
          activeExecutionRefs: ['code_session:Test Tactical Game App'],
        },
      },
      async (messages) => {
        capturedUser = messages[1]?.content ?? '';
        return {
          content: JSON.stringify({
            route: 'coding_task',
            confidence: 'high',
            operation: 'inspect',
            summary: 'Checks the status of the current coding task.',
            turnRelation: 'follow_up',
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      },
    );

    expect(capturedUser).toContain('Continuity thread context:');
    expect(capturedUser).toContain('continuity key: shared-tier:owner');
    expect(capturedUser).toContain('surface list: web:chat-main, cli:owner');
    expect(capturedUser).toContain('active execution refs: code_session:Test Tactical Game App');
    expect(capturedUser).not.toContain('focus summary:');
    expect(capturedUser).not.toContain('last actionable request:');
  });

  it('preserves coding run status check metadata', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Did Codex complete that work? Can you check?',
        channel: 'web',
      },
      async () => ({
        content: JSON.stringify({
          route: 'coding_task',
          confidence: 'high',
          operation: 'inspect',
          summary: 'Checks the status of the most recent Codex run.',
          turnRelation: 'follow_up',
          codingBackend: 'codex',
          codingRunStatusCheck: true,
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('coding_task');
    expect(result.decision.operation).toBe('inspect');
    expect(result.decision.entities.codingBackend).toBe('codex');
    expect(result.decision.entities.codingRunStatusCheck).toBe(true);
  });

  it('preserves coding backend request metadata separately from backend mentions', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Use Codex to investigate the failing build.',
        channel: 'web',
      },
      async () => ({
        content: JSON.stringify({
          route: 'coding_task',
          confidence: 'high',
          operation: 'inspect',
          summary: 'Uses Codex to investigate the failing build.',
          codingBackend: 'codex',
          codingBackendRequested: true,
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.entities.codingBackend).toBe('codex');
    expect(result.decision.entities.codingBackendRequested).toBe(true);
  });

  it('includes guidance that coding artifact explanations are not backend status checks', async () => {
    const gateway = new IntentGateway();
    let capturedSystem = '';

    await gateway.classify(
      {
        content: 'Why did Codex make that text artifact executable?',
        channel: 'web',
      },
      async (messages) => {
        capturedSystem = messages[0]?.content ?? '';
        return {
          content: JSON.stringify({
            route: 'general_assistant',
            confidence: 'high',
            operation: 'unknown',
            summary: 'Explains the file mode behavior.',
            turnRelation: 'new_request',
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      },
    );

    expect(capturedSystem).toContain('Do not set codingRunStatusCheck for questions asking why a coding backend produced a particular file');
    expect(capturedSystem).toContain('codingBackendRequested=true only when the user is explicitly asking Guardian to use or launch that coding backend for work');
    expect(capturedSystem).toContain('executable bit, mode bit, output, or artifact');
  });

  it('captures explicit enable and disable intent metadata', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Disable Browser Read Smoke in the automations page.',
        channel: 'web',
      },
      async () => ({
        content: JSON.stringify({
          route: 'ui_control',
          confidence: 'high',
          operation: 'toggle',
          summary: 'Disable an existing automation from the automations page.',
          automationName: 'Browser Read Smoke',
          uiSurface: 'automations',
          enabled: false,
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('automation_control');
    expect(result.decision.operation).toBe('toggle');
    expect(result.decision.entities.enabled).toBe(false);
  });

  it('runs a confirmation pass when capability ownership contradicts the first routing decision', async () => {
    const gateway = new IntentGateway();
    let callCount = 0;
    let confirmationSystemPrompt = '';
    let confirmationUserPrompt = '';

    const result = await gateway.classify(
      {
        content: 'Disable Browser Read Smoke in the automations page.',
        channel: 'web',
      },
      async (messages, options) => {
        callCount += 1;
        if (callCount === 1) {
          expect(options?.tools?.[0]?.name).toBe('route_intent');
          return {
            content: JSON.stringify({
              route: 'ui_control',
              confidence: 'high',
              operation: 'toggle',
              summary: 'Disable an existing automation from the automations page.',
              automationName: 'Browser Read Smoke',
              uiSurface: 'automations',
              enabled: false,
            }),
            model: 'test-model',
            finishReason: 'stop',
          } satisfies ChatResponse;
        }

        confirmationSystemPrompt = messages[0]?.content ?? '';
        confirmationUserPrompt = messages[1]?.content ?? '';
        expect(options?.responseFormat).toEqual({ type: 'json_object' });
        return {
          content: JSON.stringify({
            route: 'automation_control',
            confidence: 'high',
            operation: 'toggle',
            summary: 'Disable an existing automation.',
            automationName: 'Browser Read Smoke',
            enabled: false,
          }),
          model: 'confirm-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      },
    );

    expect(callCount).toBe(2);
    expect(result.mode).toBe('confirmation');
    expect(result.model).toBe('confirm-model');
    expect(result.decision.route).toBe('automation_control');
    expect(result.decision.operation).toBe('toggle');
    expect(confirmationSystemPrompt).toContain('intent gateway confirmation pass');
    expect(confirmationSystemPrompt).toContain('Skill names are downstream execution aids');
    expect(confirmationUserPrompt).toContain('Candidate routes: automation_control');
    expect(confirmationUserPrompt).toContain('"route":"ui_control"');
  });

  it('re-derives explicit tool work as tool-loop general assistant workload when the classifier omits workload metadata', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Run the cloud tool whm_status using profileId social.',
        channel: 'web',
      },
      async () => ({
        content: JSON.stringify({
          route: 'general_assistant',
          confidence: 'high',
          operation: 'run',
          summary: 'Runs the requested built-in cloud tool.',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('general_assistant');
    expect(result.decision.entities.toolName).toBe('whm_status');
    expect(result.decision.entities.profileId).toBe('social');
    expect(result.decision.executionClass).toBe('tool_orchestration');
    expect(result.decision.preferredTier).toBe('external');
    expect(result.decision.requiresToolSynthesis).toBe(true);
    expect(result.decision.preferredAnswerPath).toBe('tool_loop');
  });

  it('routes historical automation-output analysis to the dedicated automation output lane', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Analyze the output from the last HN Snapshot Smoke automation run. Summarize what it found.',
        channel: 'web',
      },
      async () => ({
        content: JSON.stringify({
          route: 'automation_output_task',
          confidence: 'high',
          operation: 'inspect',
          summary: 'Analyze a previous automation run using stored automation output tools.',
          automationName: 'HN Snapshot Smoke',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('automation_output_task');
    expect(result.decision.operation).toBe('inspect');
    expect(result.decision.entities.automationName).toBe('HN Snapshot Smoke');
  });

  it('repairs missing automation names for automation-control requests', async () => {
    const gateway = new IntentGateway();
    let callCount = 0;

    const result = await gateway.classify(
      {
        content: 'Run Browser Read Smoke now.',
        channel: 'web',
      },
      async (_messages, options) => {
        callCount += 1;
        if (callCount === 1) {
          expect(options?.tools?.[0]?.name).toBe('route_intent');
          return {
            content: JSON.stringify({
              route: 'automation_control',
              confidence: 'high',
              operation: 'run',
              summary: 'Run an existing automation.',
            }),
            model: 'test-model',
            finishReason: 'stop',
          } satisfies ChatResponse;
        }

        expect(options?.tools?.[0]?.name).toBe('resolve_automation_name');
        return {
          content: JSON.stringify({
            automationName: 'Browser Read Smoke',
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      },
    );

    expect(result.decision.route).toBe('automation_control');
    expect(result.decision.operation).toBe('run');
    expect(result.decision.entities.automationName).toBe('Browser Read Smoke');
    expect(callCount).toBe(2);
  });

  it('recovers explicit automation-control requests from unstructured fallback output', async () => {
    const gateway = new IntentGateway();
    let callCount = 0;

    const result = await gateway.classify(
      {
        content: 'Disable the automation called Daily Inbox Triage.',
        channel: 'web',
      },
      async (_messages, options) => {
        callCount += 1;
        if (callCount === 1) {
          expect(options?.tools?.[0]?.name).toBe('route_intent');
          throw new Error('ollama api error: failed to format route_intent tool call');
        }

        expect(options?.tools).toBeUndefined();
        expect(options?.responseFormat).toEqual({ type: 'json_object' });
        return {
          content: 'I am not sure.',
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      },
    );

    expect(callCount).toBe(2);
    expect(result.mode).toBe('json_fallback');
    expect(result.decision.route).toBe('automation_control');
    expect(result.decision.operation).toBe('toggle');
    expect(result.decision.entities.automationName).toBe('Daily Inbox Triage');
    expect(result.decision.entities.enabled).toBe(false);
  });

  it('recovers automation-output analysis requests from unstructured fallback output', async () => {
    const gateway = new IntentGateway();
    let callCount = 0;

    const result = await gateway.classify(
      {
        content: 'Analyze the output from the last HN Snapshot Smoke automation run.',
        channel: 'web',
      },
      async (_messages, options) => {
        callCount += 1;
        if (callCount === 1) {
          expect(options?.tools?.[0]?.name).toBe('route_intent');
          throw new Error('ollama api error: failed to format route_intent tool call');
        }

        expect(options?.tools).toBeUndefined();
        expect(options?.responseFormat).toEqual({ type: 'json_object' });
        return {
          content: 'Need to inspect the stored run output.',
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      },
    );

    expect(callCount).toBe(2);
    expect(result.mode).toBe('json_fallback');
    expect(result.decision.route).toBe('automation_output_task');
    expect(result.decision.operation).toBe('inspect');
    expect(result.decision.entities.automationName).toBe('HN Snapshot Smoke');
  });

  it('repairs missing automation names for follow-up rename requests using recent history', async () => {
    const gateway = new IntentGateway();
    let callCount = 0;

    const result = await gateway.classify(
      {
        content: 'Rename that automation to WHM Social Check Disk Quota.',
        channel: 'web',
        recentHistory: [
          { role: 'user', content: 'Create a manual automation that checks WHM quota headroom.' },
          { role: 'assistant', content: "I created the native Guardian manual assistant automation 'It Should Check Account'." },
        ],
        continuity: {
          continuityKey: 'default:web-user',
          linkedSurfaceCount: 1,
          focusSummary: 'Automation authoring follow-up',
          lastActionableRequest: 'Rename It Should Check Account to WHM Social Check Disk Quota.',
        },
      },
      async (messages, options) => {
        callCount += 1;
        return {
          content: JSON.stringify({
            route: 'automation_control',
            confidence: 'high',
            operation: 'update',
            summary: 'Renames the previously created automation.',
            newAutomationName: 'WHM Social Check Disk Quota',
            turnRelation: 'follow_up',
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      },
    );

    expect(result.decision.route).toBe('automation_control');
    expect(result.decision.operation).toBe('update');
    expect(result.decision.turnRelation).toBe('follow_up');
    expect(result.decision.entities.automationName).toBe('It Should Check Account');
    expect(result.decision.entities.newAutomationName).toBe('WHM Social Check Disk Quota');
    expect(callCount).toBe(1);
  });

  it('does not synthesize standalone resolved content for short coding-backend follow-ups inside the gateway', async () => {
    const gateway = new IntentGateway();
    let callCount = 0;

    const result = await gateway.classify(
      {
        content: 'Okay now do the same thing with Claude Code',
        channel: 'web',
        recentHistory: [
          { role: 'user', content: 'Use Codex in this coding workspace to inspect README.md and package.json, then reply with a short summary of what this repo does. Do not change any files.' },
          { role: 'assistant', content: 'This repo is GuardianAgent.' },
        ],
        continuity: {
          continuityKey: 'default:web-user',
          linkedSurfaceCount: 1,
          focusSummary: 'Repo summary handoff',
          lastActionableRequest: 'Use Codex in this coding workspace to inspect README.md and package.json, then reply with a short summary of what this repo does. Do not change any files.',
          activeExecutionRefs: ['code_session:Guardian Agent'],
        },
      },
      async (messages, options) => {
        callCount += 1;
        return {
          content: JSON.stringify({
            route: 'coding_task',
            confidence: 'high',
            operation: 'inspect',
            summary: 'Runs the same repo-inspection task with Claude Code.',
            turnRelation: 'new_request',
            resolution: 'ready',
            codingBackend: 'claude-code',
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      },
    );

    expect(result.decision.route).toBe('coding_task');
    expect(result.decision.operation).toBe('inspect');
    expect(result.decision.entities.codingBackend).toBe('claude-code');
    expect(result.decision.resolvedContent).toBeUndefined();
    expect(callCount).toBe(1);
  });

  it('does not run hidden historical-reference repair for ambiguous non-coding follow-ups', async () => {
    const gateway = new IntentGateway();
    let callCount = 0;

    const result = await gateway.classify(
      {
        content: 'Break this down before editing anything.',
        channel: 'web',
        recentHistory: [
          { role: 'user', content: 'Write an implementation plan for adding archived routines to this app.' },
          { role: 'assistant', content: 'I can help with that.' },
        ],
        continuity: {
          continuityKey: 'default:web-user',
          linkedSurfaceCount: 1,
          focusSummary: 'Archived routines implementation planning',
          lastActionableRequest: 'Write an implementation plan for adding archived routines to this app.',
          continuationStateKind: 'planning',
        },
      },
      async (messages, options) => {
        callCount += 1;
        return {
          content: JSON.stringify({
            route: 'workspace_task',
            confidence: 'high',
            operation: 'read',
            summary: 'Breaks the archived-routines implementation plan into phases before any edits.',
            turnRelation: 'follow_up',
            resolution: 'ready',
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      },
    );

    expect(result.decision.route).toBe('workspace_task');
    expect(result.decision.operation).toBe('read');
    expect(result.decision.resolvedContent).toBeUndefined();
    expect(callCount).toBe(1);
  });

  it('classifies session listing as coding_session_control with navigate operation', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'List my coding workspaces.',
        channel: 'web',
      },
      async () => ({
        content: '',
        toolCalls: [{
          id: 'call-1',
          name: 'route_intent',
          arguments: JSON.stringify({
            route: 'coding_session_control',
            confidence: 'high',
            operation: 'navigate',
            summary: 'Lists available coding workspace sessions.',
          }),
        }],
        model: 'test-model',
        finishReason: 'tool_calls',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('coding_session_control');
    expect(result.decision.operation).toBe('navigate');
    expect(result.available).toBe(true);
  });

  it('classifies session switching as coding_session_control with sessionTarget entity', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Switch to the Guardian project workspace.',
        channel: 'web',
      },
      async () => ({
        content: '',
        toolCalls: [{
          id: 'call-1',
          name: 'route_intent',
          arguments: JSON.stringify({
            route: 'coding_session_control',
            confidence: 'high',
            operation: 'update',
            summary: 'Switches to a specific coding workspace session.',
            sessionTarget: 'Guardian project',
          }),
        }],
        model: 'test-model',
        finishReason: 'tool_calls',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('coding_session_control');
    expect(result.decision.operation).toBe('update');
    expect(result.decision.entities.sessionTarget).toBe('Guardian project');
  });

  it('classifies current session query as coding_session_control with inspect operation', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'What coding session am I on?',
        channel: 'cli',
      },
      async () => ({
        content: JSON.stringify({
          route: 'coding_session_control',
          confidence: 'high',
          operation: 'inspect',
          summary: 'Inspects the currently attached coding workspace session.',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('coding_session_control');
    expect(result.decision.operation).toBe('inspect');
    expect(result.decision.entities.sessionTarget).toBeUndefined();
  });

  it('normalizes natural route and operation variants from local-model JSON fallbacks', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'What coding workspace is this chat currently attached to?',
        channel: 'web',
      },
      async () => ({
        content: JSON.stringify({
          route: 'coding session control',
          confidence: 'high',
          operation: 'current',
          summary: 'Checks the current attached coding workspace session.',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('coding_session_control');
    expect(result.decision.operation).toBe('inspect');
  });

  it('parses fenced JSON fallbacks with smart quotes and session-switch variants', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Switch this chat to the coding workspace for Temp install test.',
        channel: 'web',
      },
      async () => ({
        content: [
          '```json',
          '{',
          '  \u201croute\u201d: \u201ccoding workspace management\u201d,',
          '  \u201cconfidence\u201d: \u201chigh\u201d,',
          '  \u201coperation\u201d: \u201cswitch workspace\u201d,',
          '  \u201csummary\u201d: \u201cSwitch the attached coding workspace session.\u201d,',
          '  \u201csessionTarget\u201d: \u201cTemp install test\u201d',
          '}',
          '```',
        ].join('\n'),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('coding_session_control');
    expect(result.decision.operation).toBe('update');
    expect(result.decision.entities.sessionTarget).toBe('Temp install test');
  });

  it('classifies actual code execution as coding_task, not coding_session_control', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Write a function that sorts an array by date.',
        channel: 'web',
      },
      async () => ({
        content: '',
        toolCalls: [{
          id: 'call-1',
          name: 'route_intent',
          arguments: JSON.stringify({
            route: 'coding_task',
            confidence: 'high',
            operation: 'create',
            summary: 'Code generation request for writing a sort function.',
          }),
        }],
        model: 'test-model',
        finishReason: 'tool_calls',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('coding_task');
    expect(result.decision.route).not.toBe('coding_session_control');
  });

  it('repairs explicit remote sandbox execution requests that were misclassified as coding_session_control', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'In the Guardian workspace, run `pwd` in the remote sandbox using the Daytona profile for this coding session.',
        channel: 'web',
      },
      async () => ({
        content: JSON.stringify({
          route: 'coding_session_control',
          confidence: 'high',
          operation: 'navigate',
          summary: 'Lists available coding workspaces.',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('coding_task');
    expect(result.decision.operation).toBe('run');
    expect(result.decision.entities.command).toBe('pwd');
    expect(result.decision.entities.codingRemoteExecRequested).toBe(true);
    expect(result.decision.entities.sessionTarget).toBe('Guardian');
    expect(result.decision.preferredTier).toBe('external');
  });

  it('repairs repo inspection requests that were misclassified as coding_session_control', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Inspect this repo and tell me which files implement delegated worker progress and run timeline rendering. Do not edit anything.',
        channel: 'web',
      },
      async () => ({
        content: JSON.stringify({
          route: 'coding_session_control',
          confidence: 'high',
          operation: 'inspect',
          summary: 'Inspect repository to identify files implementing delegated worker progress and timeline rendering.',
          turnRelation: 'new_request',
          resolution: 'ready',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('coding_task');
    expect(result.decision.operation).toBe('inspect');
    expect(result.decision.requiresRepoGrounding).toBe(true);
    expect(result.decision.preferredAnswerPath).toBe('chat_synthesis');
  });

  it('repairs explicit remote sandbox execution requests that were misclassified as filesystem work', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'In the Guardian workspace, using the existing Daytona sandbox for this coding session, create tmp/daytona-sequence-test.txt containing exactly "daytona resumed ok", then read it back and report the exact contents. Reuse the current managed sandbox if it exists; if it is stopped, restart that same sandbox instead of creating a new one.',
        channel: 'web',
      },
      async () => ({
        content: JSON.stringify({
          route: 'filesystem_task',
          confidence: 'low',
          operation: 'create',
          summary: 'Creates a tmp file and reads it back.',
          turnRelation: 'new_request',
          resolution: 'ready',
          path: 'tmp/daytona-sequence-test.txt',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('coding_task');
    expect(result.decision.operation).toBe('run');
    expect(result.decision.entities.sessionTarget).toBe('Guardian');
  });

  it('recovers explicit remote sandbox runs from unavailable gateway output', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'In the Guardian workspace, run `npm ci` in the remote sandbox using the Daytona profile for this coding session, then run `npm test` in the same remote sandbox.',
        channel: 'web',
      },
      async () => ({
        content: '{\n  "route": "coding_session_control",\n  "operation": "run",\n  "confidence": "high"',
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.available).toBe(true);
    expect(result.decision.route).toBe('coding_task');
    expect(result.decision.operation).toBe('run');
    expect(result.decision.entities.command).toBe('npm ci');
    expect(result.decision.entities.codingRemoteExecRequested).toBe(true);
    expect(result.decision.entities.sessionTarget).toBe('Guardian');
    expect(result.decision.preferredTier).toBe('external');
    expect(result.decision.preferredAnswerPath).toBe('tool_loop');
  });

  it('recovers standalone greetings from unavailable gateway output', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Hello',
        channel: 'web',
      },
      async () => ({
        content: JSON.stringify({
          route: 'unknown',
          operation: 'unknown',
          confidence: 'low',
          summary: 'No classification summary provided.',
          turnRelation: 'new_request',
          resolution: 'ready',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.available).toBe(true);
    expect(result.decision.route).toBe('general_assistant');
    expect(result.decision.operation).toBe('inspect');
    expect(result.decision.preferredAnswerPath).toBe('direct');
    expect(result.decision.simpleVsComplex).toBe('simple');
  });

  it('captures correction metadata and resolved content for coding backend repairs', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Codex, the CLI coding assistant.',
        channel: 'web',
        recentHistory: [
          { role: 'user', content: 'Use Codex to say hello and confirm you are working. Just respond with a brief confirmation message. Do not change any files.' },
          { role: 'assistant', content: 'I can use either Google Workspace (Gmail) or Microsoft 365 (Outlook) for that email task. Which one do you want me to use?' },
        ],
      },
      async () => ({
        content: JSON.stringify({
          route: 'coding_task',
          confidence: 'high',
          operation: 'run',
          summary: 'Corrects the prior misunderstanding and requests Codex for the original coding task.',
          turnRelation: 'correction',
          resolution: 'ready',
          codingBackend: 'codex',
          resolvedContent: 'Use Codex to say hello and confirm you are working. Just respond with a brief confirmation message. Do not change any files.',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('coding_task');
    expect(result.decision.turnRelation).toBe('correction');
    expect(result.decision.resolution).toBe('ready');
    expect(result.decision.entities.codingBackend).toBe('codex');
    expect(result.decision.resolvedContent).toContain('Use Codex to say hello');
  });

  it('captures clarification answers for provider-specific mailbox follow-ups', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Use Outlook.',
        channel: 'web',
        pendingAction: {
          id: 'pending-email-provider',
          status: 'pending',
          blockerKind: 'clarification',
          field: 'email_provider',
          route: 'email_task',
          operation: 'read',
          prompt: 'I can use either Google Workspace (Gmail) or Microsoft 365 (Outlook) for that email task. Which one do you want me to use?',
          originalRequest: 'Check my email.',
        },
      },
      async () => ({
        content: JSON.stringify({
          route: 'email_task',
          confidence: 'high',
          operation: 'read',
          summary: 'Selects Outlook for the previously requested mailbox read.',
          turnRelation: 'clarification_answer',
          resolution: 'ready',
          emailProvider: 'm365',
          resolvedContent: 'Use Outlook / Microsoft 365 to check my email.',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('email_task');
    expect(result.decision.turnRelation).toBe('clarification_answer');
    expect(result.decision.entities.emailProvider).toBe('m365');
    expect(result.decision.resolvedContent).toContain('Outlook / Microsoft 365');
  });

  it('repairs satisfied email-provider clarifications even when the classifier leaves them as new requests', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Gmail.',
        channel: 'web',
        pendingAction: {
          id: 'pending-email-provider',
          status: 'pending',
          blockerKind: 'clarification',
          field: 'email_provider',
          route: 'email_task',
          operation: 'read',
          prompt: 'I can use either Google Workspace (Gmail) or Microsoft 365 (Outlook) for that email task. Which one do you want me to use?',
          originalRequest: 'Check my email.',
        },
      },
      async () => ({
        content: JSON.stringify({
          route: 'email_task',
          confidence: 'high',
          operation: 'read',
          summary: 'Check my email in Gmail.',
          turnRelation: 'new_request',
          resolution: 'needs_clarification',
          missingFields: ['email_provider'],
          emailProvider: 'gws',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('email_task');
    expect(result.decision.turnRelation).toBe('clarification_answer');
    expect(result.decision.resolution).toBe('ready');
    expect(result.decision.missingFields).not.toContain('email_provider');
    expect(result.decision.entities.emailProvider).toBe('gws');
    expect(result.decision.resolvedContent).toContain('Gmail / Google Workspace');
  });

  it('repairs satisfied path clarifications into a corrected actionable request', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Please create an empty file at C:\\tmp\\brokered-test.txt.',
        channel: 'web',
        pendingAction: {
          id: 'pending-path',
          status: 'pending',
          blockerKind: 'clarification',
          field: 'path',
          route: 'filesystem_task',
          operation: 'create',
          prompt: 'Which external path should I use?',
          originalRequest: 'Please create an empty file called brokered-test.txt in the requested external directory.',
        },
      },
      async () => ({
        content: 'I need the exact external path before I can request approval. Please tell me which directory or full file path you want me to use for brokered-test.txt.',
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('filesystem_task');
    expect(result.decision.turnRelation).toBe('clarification_answer');
    expect(result.decision.resolution).toBe('ready');
    expect(result.decision.entities.path).toBe('C:\\tmp\\brokered-test.txt');
    expect(result.decision.resolvedContent).toContain('Use path C:\\tmp\\brokered-test.txt');
    expect(result.decision.resolvedContent).toContain('requested external directory');
  });

  it('asks for clarification instead of guessing between repo work and coding-session control', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Inspect the Guardian workspace and tell me what matters most.',
        channel: 'web',
      },
      async () => ({
        content: JSON.stringify({
          route: 'coding_session_control',
          confidence: 'medium',
          operation: 'inspect',
          summary: 'Inspects the current coding workspace.',
          turnRelation: 'new_request',
          resolution: 'ready',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('coding_session_control');
    expect(result.decision.resolution).toBe('needs_clarification');
    expect(result.decision.missingFields).toContain('intent_route');
    expect(result.decision.summary).toContain('inspect or work inside the repo');
  });

  it('does not ask for Guardian-vs-website clarification when the request explicitly names GitHub', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Open the GitHub page for this repository.',
        channel: 'web',
      },
      async () => ({
        content: JSON.stringify({
          route: 'browser_task',
          confidence: 'high',
          operation: 'navigate',
          summary: 'Open the GitHub page for the repository.',
          turnRelation: 'new_request',
          resolution: 'ready',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('browser_task');
    expect(result.decision.operation).toBe('navigate');
    expect(result.decision.resolution).toBe('ready');
    expect(result.decision.missingFields).not.toContain('intent_route');
  });

  it('resolves intent-route clarification answers back onto the original request', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Repo work.',
        channel: 'web',
        pendingAction: {
          id: 'pending-intent-route',
          status: 'pending',
          blockerKind: 'clarification',
          field: 'intent_route',
          prompt: 'Do you want me to inspect or work inside the repo, or do you want me to manage the current coding workspace/session?',
          originalRequest: 'Inspect the Guardian workspace and tell me what matters most.',
          entities: {
            intentRouteCandidates: ['coding_task', 'coding_session_control'],
          },
          options: [
            { value: 'coding_task', label: 'Repo work' },
            { value: 'coding_session_control', label: 'Workspace/session control' },
          ],
          transferPolicy: 'linked_surfaces_same_user',
        },
      },
      async () => ({
        content: JSON.stringify({
          route: 'coding_task',
          confidence: 'high',
          operation: 'inspect',
          summary: 'Inspects the repo in the current workspace.',
          turnRelation: 'new_request',
          resolution: 'ready',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('coding_task');
    expect(result.decision.turnRelation).toBe('clarification_answer');
    expect(result.decision.resolution).toBe('ready');
    expect(result.decision.missingFields).not.toContain('intent_route');
    expect(result.decision.resolvedContent).toBe(
      'Inspect the Guardian workspace and tell me what matters most.',
    );
  });

  it('resolves generic intent-route clarification answers back onto the original request', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Search the web.',
        channel: 'web',
        pendingAction: {
          id: 'pending-generic-intent-route',
          status: 'pending',
          blockerKind: 'clarification',
          field: 'intent_route',
          prompt: 'Do you want me to search the web, inspect a specific website, or do something else?',
          originalRequest: 'Look into OpenAI pricing for me.',
          entities: {
            intentRouteHint: 'search_task',
          },
          transferPolicy: 'linked_surfaces_same_user',
        },
      },
      async () => ({
        content: JSON.stringify({
          route: 'search_task',
          confidence: 'high',
          operation: 'search',
          summary: 'Searches the web for the requested topic.',
          turnRelation: 'clarification_answer',
          resolution: 'ready',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('search_task');
    expect(result.decision.turnRelation).toBe('clarification_answer');
    expect(result.decision.resolution).toBe('ready');
    expect(result.decision.missingFields).not.toContain('intent_route');
    expect(result.decision.resolvedContent).toBe('Look into OpenAI pricing for me.');
  });

  it('captures mailbox read mode for latest inbox requests', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Can you show me the newest five emails in Gmail?',
        channel: 'web',
      },
      async () => ({
        content: JSON.stringify({
          route: 'email_task',
          confidence: 'high',
          operation: 'read',
          summary: 'Lists the latest Gmail inbox messages.',
          emailProvider: 'gws',
          mailboxReadMode: 'latest',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('email_task');
    expect(result.decision.operation).toBe('read');
    expect(result.decision.entities.emailProvider).toBe('gws');
    expect(result.decision.entities.mailboxReadMode).toBe('latest');
  });

  it('requires provider clarification for ambiguous mailbox reads when both mail providers are enabled', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Check my email.',
        channel: 'web',
        enabledManagedProviders: ['gws', 'm365'],
      },
      async () => ({
        content: JSON.stringify({
          route: 'email_task',
          confidence: 'medium',
          operation: 'read',
          summary: 'Checks the mailbox.',
          resolution: 'ready',
          missingFields: [],
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('email_task');
    expect(result.decision.operation).toBe('read');
    expect(result.decision.resolution).toBe('needs_clarification');
    expect(result.decision.entities.emailProvider).toBeUndefined();
    expect(result.decision.missingFields).toContain('email_provider');
  });

  it('selects the only enabled mail provider when mailbox classification omits it', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Check my email.',
        channel: 'web',
        enabledManagedProviders: ['m365'],
      },
      async () => ({
        content: JSON.stringify({
          route: 'email_task',
          confidence: 'medium',
          operation: 'read',
          summary: 'Checks the mailbox.',
          resolution: 'ready',
          missingFields: [],
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('email_task');
    expect(result.decision.operation).toBe('read');
    expect(result.decision.resolution).toBe('ready');
    expect(result.decision.entities.emailProvider).toBe('m365');
    expect(result.decision.provenance?.entities).toMatchObject({
      emailProvider: 'resolver.email',
    });
  });

  it('infers Outlook mailbox metadata when fallback output omits provider details', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'Check my unread Outlook mail.',
        channel: 'web',
      },
      async () => ({
        content: JSON.stringify({
          route: 'email_task',
          confidence: 'medium',
          operation: 'read',
          summary: 'Checks the inbox.',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('email_task');
    expect(result.decision.operation).toBe('read');
    expect(result.decision.entities.emailProvider).toBe('m365');
    expect(result.decision.entities.mailboxReadMode).toBe('unread');
    expect(result.decision.provenance?.entities).toMatchObject({
      emailProvider: 'resolver.email',
      mailboxReadMode: 'resolver.email',
    });
  });

  it('captures clarification answers for automation-selection follow-ups', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'WHM Social Check Disk Quota.',
        channel: 'web',
        pendingAction: {
          id: 'pending-automation-name',
          status: 'pending',
          blockerKind: 'clarification',
          field: 'automation_name',
          route: 'automation_control',
          operation: 'update',
          prompt: 'Tell me which automation you want to inspect, run, rename, enable, disable, or edit.',
          originalRequest: 'No edit that automation, make it scheduled and run daily at 9:00 am.',
        },
      },
      async () => ({
        content: JSON.stringify({
          route: 'automation_control',
          confidence: 'high',
          operation: 'update',
          summary: 'Selects the automation to update.',
          turnRelation: 'clarification_answer',
          resolution: 'ready',
          automationName: 'WHM Social Check Disk Quota',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('automation_control');
    expect(result.decision.turnRelation).toBe('clarification_answer');
    expect(result.decision.entities.automationName).toBe('WHM Social Check Disk Quota');
  });

  it('repairs automation-name clarification answers from recent history when pending clarification metadata is missing', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classify(
      {
        content: 'The one you just created',
        channel: 'web',
        recentHistory: [
          { role: 'user', content: 'Disable the weekly review automation.' },
          { role: 'assistant', content: 'Tell me which automation you want to inspect, run, rename, enable, disable, or edit.' },
        ],
      },
      async () => ({
        content: JSON.stringify({
          route: 'automation_control',
          confidence: 'low',
          operation: 'unknown',
          summary: 'Select the automation to update or control.',
          turnRelation: 'new_request',
          resolution: 'ready',
        }),
        model: 'test-model',
        finishReason: 'stop',
      } satisfies ChatResponse),
    );

    expect(result.decision.route).toBe('automation_control');
    expect(result.decision.operation).toBe('toggle');
    expect(result.decision.turnRelation).toBe('clarification_answer');
    expect(result.decision.resolution).toBe('ready');
    expect(result.decision.entities.automationName).toBe('The one you just created');
    expect(result.decision.entities.enabled).toBe(false);
    expect(result.decision.resolvedContent).toBe('Disable the weekly review automation.');
  });

  it('round-trips pre-routed gateway metadata for downstream reuse', () => {
    const metadata = attachPreRoutedIntentGatewayMetadata(
      { existing: true },
      {
        mode: 'primary',
        available: true,
        model: 'test-model',
        latencyMs: 12,
        promptProfile: 'compact',
        decision: {
          route: 'coding_task',
          confidence: 'high',
          operation: 'run',
          summary: 'Run Codex for the requested coding task.',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          provenance: {
            route: 'classifier.primary',
            operation: 'classifier.primary',
            entities: {
              codingBackend: 'classifier.primary',
            },
          },
          entities: {
            codingBackend: 'codex',
          },
        },
      },
    );

    expect(readPreRoutedIntentGatewayMetadata(metadata)).toMatchObject({
      available: true,
      model: 'test-model',
      promptProfile: 'compact',
      decision: {
        route: 'coding_task',
        provenance: {
          route: 'classifier.primary',
          entities: {
            codingBackend: 'classifier.primary',
          },
        },
        entities: {
          codingBackend: 'codex',
        },
      },
    });
  });

  it('round-trips complex planning preroutes without degrading them to unknown', () => {
    const metadata = attachPreRoutedIntentGatewayMetadata(
      undefined,
      {
        mode: 'primary',
        available: true,
        model: 'test-model',
        latencyMs: 8,
        decision: {
          route: 'complex_planning_task',
          confidence: 'high',
          operation: 'run',
          summary: 'Use the planner path for this request.',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          entities: {},
        },
      },
    );

    expect(readPreRoutedIntentGatewayMetadata(metadata)).toMatchObject({
      available: true,
      model: 'test-model',
      decision: {
        route: 'complex_planning_task',
        executionClass: 'tool_orchestration',
        preferredTier: 'external',
      },
    });
  });

  it('reuses structured pre-routed gateway metadata even when the preroute degraded', () => {
    const metadata = attachPreRoutedIntentGatewayMetadata(
      undefined,
      {
        mode: 'primary',
        available: false,
        model: 'unknown',
        latencyMs: 3,
        decision: {
          route: 'unknown',
          confidence: 'low',
          operation: 'unknown',
          summary: 'Routing provider unavailable.',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          entities: {},
        },
      },
    );

    const preRouted = readPreRoutedIntentGatewayMetadata(metadata);
    expect(preRouted?.available).toBe(false);
    expect(shouldReusePreRoutedIntentGateway(preRouted)).toBe(true);
  });

  it('drops stale pre-routed metadata without disturbing other message metadata', () => {
    const metadata = attachPreRoutedIntentGatewayMetadata(
      { codeContext: { workspaceRoot: '/repo' }, other: 'keep-me' },
      {
        mode: 'primary',
        available: true,
        model: 'test-model',
        latencyMs: 1,
        decision: {
          route: 'coding_session_control',
          confidence: 'high',
          operation: 'run',
          summary: 'Lists coding workspaces.',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          entities: {},
        },
      },
    );

    const stripped = detachPreRoutedIntentGatewayMetadata(metadata);

    expect(readPreRoutedIntentGatewayMetadata(stripped)).toBeNull();
    expect(stripped).toEqual({
      codeContext: { workspaceRoot: '/repo' },
      other: 'keep-me',
    });
  });

  it('only reuses pre-routed metadata when the effective routing content is unchanged', () => {
    const metadata = attachPreRoutedIntentGatewayMetadata(
      undefined,
      {
        mode: 'primary',
        available: true,
        model: 'test-model',
        latencyMs: 1,
        decision: {
          route: 'coding_session_control',
          confidence: 'high',
          operation: 'run',
          summary: 'Lists coding workspaces.',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          entities: {},
        },
      },
    );
    const preRouted = readPreRoutedIntentGatewayMetadata(metadata);

    expect(shouldReusePreRoutedIntentGatewayForContent(
      preRouted,
      'It is running now. Try again.',
      'In the Guardian workspace, run `pwd` in the remote sandbox and report exact stdout.',
    )).toBe(false);
    expect(shouldReusePreRoutedIntentGatewayForContent(
      preRouted,
      '  In the Guardian workspace, run `pwd` in the remote sandbox and report exact stdout.  ',
      'In the Guardian workspace, run `pwd` in the remote sandbox and report exact stdout.',
    )).toBe(true);
  });
});
