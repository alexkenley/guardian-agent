import { describe, expect, it } from 'vitest';
import type { ChatResponse } from '../llm/types.js';
import { IntentGateway, toIntentGatewayClientMetadata } from './intent-gateway.js';

describe('IntentGateway', () => {
  it('parses a tool-called structured intent decision', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classifyShadow(
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
    expect(result.decision.entities.automationName).toBe('Browser Read Smoke');
    expect(result.decision.entities.manualOnly).toBe(true);
    expect(result.model).toBe('test-model');
  });

  it('falls back to parsing JSON content when no tool call is present', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classifyShadow(
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

  it('returns an unknown decision when the model response is not structured', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classifyShadow(
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

  it('converts shadow decisions into client-safe metadata', () => {
    const metadata = toIntentGatewayClientMetadata({
      mode: 'shadow',
      model: 'test-model',
      latencyMs: 17,
      decision: {
        route: 'ui_control',
        confidence: 'medium',
        operation: 'navigate',
        summary: 'Refers to a Guardian page.',
        entities: {
          uiSurface: 'automations',
        },
      },
    });

    expect(metadata).toMatchObject({
      mode: 'shadow',
      model: 'test-model',
      route: 'ui_control',
      operation: 'navigate',
    });
  });

  it('supports broader direct-action routes beyond browser and automation', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classifyShadow(
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

  it('captures explicit enable and disable intent metadata', async () => {
    const gateway = new IntentGateway();
    const result = await gateway.classifyShadow(
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

    expect(result.decision.route).toBe('ui_control');
    expect(result.decision.operation).toBe('toggle');
    expect(result.decision.entities.enabled).toBe(false);
  });

  it('repairs missing automation names for automation-control requests', async () => {
    const gateway = new IntentGateway();
    let callCount = 0;

    const result = await gateway.classifyShadow(
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
});
