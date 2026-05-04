import { describe, expect, it } from 'vitest';
import type { ChatResponse } from '../../llm/types.js';
import { buildIntentGatewayContextSections, classifyIntentGatewayPass } from './route-classifier.js';

describe('buildIntentGatewayContextSections', () => {
  it('includes configured document source routing context without raw paths', () => {
    const context = buildIntentGatewayContextSections({
      content: 'Search product-docs for billing JSON files.',
      channel: 'web',
      configuredSearchSources: [
        {
          id: 'product-docs',
          name: 'Product Docs',
          type: 'directory',
          enabled: true,
          indexedSearchAvailable: true,
          documentCount: 12,
          chunkCount: 44,
        },
        {
          id: 'guardian-repo',
          name: 'Guardian Repo',
          type: 'git',
          enabled: true,
          indexedSearchAvailable: false,
        },
      ],
    }).join('\n');

    expect(context).toContain('Configured document search sources:');
    expect(context).toContain('id=product-docs; name=Product Docs; type=directory; enabled=true; indexedSearchAvailable=true; documents=12; chunks=44');
    expect(context).toContain('id=guardian-repo; name=Guardian Repo; type=git; enabled=true; indexedSearchAvailable=false');
    expect(context).not.toContain('C:\\');
    expect(context).not.toContain('https://');
  });

  it('keeps fallback routing prompts aligned with diagnostics route ownership', async () => {
    const prompts: string[] = [];
    const result = await classifyIntentGatewayPass(
      {
        content: 'Draft a GuardianAgent problem report from diagnostics for the latest completed assistant request. Do not create a GitHub issue.',
        channel: 'web',
      },
      async (messages) => {
        prompts.push(messages[0]?.content ?? '');
        return {
          content: JSON.stringify({
            route: 'diagnostics_task',
            operation: 'draft',
            confidence: 'high',
            summary: 'Draft a redacted GuardianAgent diagnostic issue report.',
            turnRelation: 'new_request',
            resolution: 'ready',
            toolName: 'guardian_issue_draft',
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      },
      {
        mode: 'route_only_fallback',
        startedAt: Date.now(),
        promptProfile: 'full',
      },
    );

    expect(prompts[0]).toContain('diagnostics_task');
    expect(result.decision.route).toBe('diagnostics_task');
    expect(result.decision.operation).toBe('draft');
    expect(result.decision.requiresToolSynthesis).toBe(true);
    expect(result.decision.preferredAnswerPath).toBe('tool_loop');
  });

  it('keeps JSON fallback guidance tied to the diagnostics issue draft tool', async () => {
    let systemPrompt = '';
    await classifyIntentGatewayPass(
      {
        content: 'Draft a GuardianAgent problem report from diagnostics for the latest completed assistant request. Do not create a GitHub issue.',
        channel: 'web',
      },
      async (messages) => {
        systemPrompt = messages[0]?.content ?? '';
        return {
          content: JSON.stringify({
            route: 'diagnostics_task',
            operation: 'draft',
            confidence: 'high',
            summary: 'Draft a redacted GuardianAgent diagnostic issue report.',
            turnRelation: 'new_request',
            resolution: 'ready',
            toolName: 'guardian_issue_draft',
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      },
      {
        mode: 'json_fallback',
        startedAt: Date.now(),
        promptProfile: 'full',
      },
    );

    expect(systemPrompt).toContain('diagnostics_task');
    expect(systemPrompt).toContain('guardian_issue_draft');
  });

  it('normalizes GuardianAgent GitHub issue route aliases to diagnostics drafts', async () => {
    const prompts: string[] = [];
    const result = await classifyIntentGatewayPass(
      {
        content: 'Create a GuardianAgent GitHub issue for the last bad response.',
        channel: 'web',
      },
      async (messages) => {
        prompts.push(messages[0]?.content ?? '');
        return {
          content: JSON.stringify({
            route: 'guardian_agent_github_issue',
            operation: 'draft',
            confidence: 'high',
            summary: 'Draft a redacted GuardianAgent GitHub issue for the last bad response.',
            turnRelation: 'new_request',
            resolution: 'ready',
            toolName: 'guardian_issue_draft',
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      },
      {
        mode: 'json_fallback',
        startedAt: Date.now(),
        promptProfile: 'full',
      },
    );

    expect(prompts[0]).toContain('Create a GuardianAgent GitHub issue');
    expect(result.decision.route).toBe('diagnostics_task');
    expect(result.decision.operation).toBe('draft');
    expect(result.decision.entities.toolName).toBe('guardian_issue_draft');
    expect(result.decision.requiresToolSynthesis).toBe(true);
    expect(result.decision.preferredAnswerPath).toBe('tool_loop');
  });

  it('guides reviewed GuardianAgent issue submissions through the diagnostics submit route', async () => {
    let systemPrompt = '';
    const result = await classifyIntentGatewayPass(
      {
        content: 'Submit this GitHub issue.',
        channel: 'web',
        recentHistory: [
          {
            role: 'assistant',
            content: 'Drafted a redacted GuardianAgent issue report. No GitHub issue was created.',
          },
        ],
      },
      async (messages) => {
        systemPrompt = messages[0]?.content ?? '';
        return {
          content: JSON.stringify({
            route: 'diagnostics_task',
            operation: 'send',
            confidence: 'high',
            summary: 'Submit the reviewed GuardianAgent diagnostics issue draft.',
            turnRelation: 'follow_up',
            resolution: 'ready',
            toolName: 'github_issue_create',
          }),
          model: 'test-model',
          finishReason: 'stop',
        } satisfies ChatResponse;
      },
      {
        mode: 'json_fallback',
        startedAt: Date.now(),
        promptProfile: 'full',
      },
    );

    expect(systemPrompt).toContain('operation="send"');
    expect(systemPrompt).toContain('github_issue_create');
    expect(result.decision.route).toBe('diagnostics_task');
    expect(result.decision.operation).toBe('send');
    expect(result.decision.entities.toolName).toBe('github_issue_create');
    expect(result.decision.turnRelation).toBe('follow_up');
  });
});
