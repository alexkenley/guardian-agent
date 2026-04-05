import { describe, expect, it } from 'vitest';
import type { ChatResponse } from '../llm/types.js';
import {
  IntentGateway,
  attachPreRoutedIntentGatewayMetadata,
  readPreRoutedIntentGatewayMetadata,
  shouldReusePreRoutedIntentGateway,
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

    expect(inspectedSystemPrompt).toContain('Requests to inspect, explain, review, or plan changes against specific repo files');
    expect(inspectedSystemPrompt).toContain('Inspect src/skills/prompt.ts and src/chat-agent.ts. Review the uplift for regressions and missing tests.');
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
    expect(primaryPrompt).toContain('Prefer personal_assistant_task for meeting prep, follow-up drafting, calendar planning');
    expect(primaryPrompt).toContain('Example: "Prepare me for my next Outlook meeting using the calendar event, recent email, and docs." -> route=personal_assistant_task');
    expect(primaryPrompt).toContain('SharePoint');
    expect(fallbackPrompt).toContain('workspace_task means explicit provider CRUD or administration in Google Workspace or Microsoft 365 surfaces');
    expect(fallbackPrompt).toContain('Examples: "Update the SharePoint document for the launch checklist." -> route="workspace_task", operation="update".');
    expect(fallbackPrompt).toContain('Examples: "Check my unread Outlook mail." -> route="email_task", operation="read", emailProvider="m365".');
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
    expect(capturedUser).toContain('focus summary: Continue the active coding task.');
    expect(capturedUser).toContain('last actionable request: Use Codex to create the smoke test file.');
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

    expect(result.decision.route).toBe('ui_control');
    expect(result.decision.operation).toBe('toggle');
    expect(result.decision.entities.enabled).toBe(false);
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
        if (callCount === 1) {
          expect(options?.tools?.[0]?.name).toBe('route_intent');
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
        }

        expect(options?.tools?.[0]?.name).toBe('resolve_automation_name');
        const userPrompt = messages[messages.length - 1]?.content || '';
        expect(userPrompt).toContain('It Should Check Account');
        expect(userPrompt).toContain('Last actionable request');
        return {
          content: JSON.stringify({
            automationName: 'It Should Check Account',
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
    expect(callCount).toBe(2);
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

  it('round-trips pre-routed gateway metadata for downstream reuse', () => {
    const metadata = attachPreRoutedIntentGatewayMetadata(
      { existing: true },
      {
        mode: 'primary',
        available: true,
        model: 'test-model',
        latencyMs: 12,
        decision: {
          route: 'coding_task',
          confidence: 'high',
          operation: 'run',
          summary: 'Run Codex for the requested coding task.',
          turnRelation: 'new_request',
          resolution: 'ready',
          missingFields: [],
          entities: {
            codingBackend: 'codex',
          },
        },
      },
    );

    expect(readPreRoutedIntentGatewayMetadata(metadata)).toMatchObject({
      available: true,
      model: 'test-model',
      decision: {
        route: 'coding_task',
        entities: {
          codingBackend: 'codex',
        },
      },
    });
  });

  it('does not reuse pre-routed gateway metadata when the preroute was unavailable', () => {
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
    expect(shouldReusePreRoutedIntentGateway(preRouted)).toBe(false);
  });
});
