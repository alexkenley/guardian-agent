import { describe, expect, it } from 'vitest';
import { resolveIntentGatewayEntities } from './route-entity-resolution.js';

describe('resolveIntentGatewayEntities', () => {
  it('preserves automation read view for automation-control count requests', () => {
    const result = resolveIntentGatewayEntities(
      { automationReadView: 'count' },
      { sourceContent: 'How many automations are configured?' },
      'automation_control',
      'read',
      'classifier.primary',
    );

    expect(result.entities.automationReadView).toBe('count');
    expect(result.provenance?.automationReadView).toBe('classifier.primary');
  });

  it('infers automation count read view when classifier omits it', () => {
    const result = resolveIntentGatewayEntities(
      {},
      { sourceContent: 'List how many automations are currently configured.' },
      'automation_control',
      'read',
      'classifier.route_only_fallback',
    );

    expect(result.entities.automationReadView).toBe('count');
    expect(result.provenance?.automationReadView).toBe('resolver.automation');
  });

  it('marks provider inventory requests as config-surface general assistant work', () => {
    expect(resolveIntentGatewayEntities(
      {},
      { sourceContent: 'Show me the configured AI providers and available models.' },
      'general_assistant',
      'inspect',
      'classifier.primary',
    ).entities).toMatchObject({
      uiSurface: 'config',
    });
  });

  it('infers mailbox provider and read mode from mailbox requests', () => {
    const result = resolveIntentGatewayEntities(
      {},
      { sourceContent: 'Check my unread Outlook mail.' },
      'email_task',
      'read',
      'classifier.primary',
    );

    expect(result.entities).toMatchObject({
      emailProvider: 'm365',
      mailboxReadMode: 'unread',
    });
    expect(result.provenance).toMatchObject({
      emailProvider: 'resolver.email',
      mailboxReadMode: 'resolver.email',
    });
  });

  it('infers coding backend and workspace target from explicit backend requests', () => {
    expect(resolveIntentGatewayEntities(
      {},
      { sourceContent: 'Use Codex to inspect src/runtime/intent-gateway.ts in the Guardian workspace.' },
      'coding_task',
      'inspect',
      'classifier.primary',
    ).entities).toMatchObject({
      codingBackend: 'codex',
      codingBackendRequested: true,
      sessionTarget: 'Guardian',
    });
  });

  it('does not treat negated backend mentions as delegated coding backend requests', () => {
    const result = resolveIntentGatewayEntities(
      {},
      {
        sourceContent: 'In one sentence, what kind of application is this workspace? Do not use Codex for this; answer directly from the current coding context.',
      },
      'coding_task',
      'inspect',
      'classifier.primary',
    );

    expect(result.entities.codingBackend).toBeUndefined();
    expect(result.entities.codingBackendRequested).toBeUndefined();
    expect(result.entities.sessionTarget).toBeUndefined();
  });

  it('drops classifier-provided coding-task session targets when the source does not explicitly name a target workspace', () => {
    const result = resolveIntentGatewayEntities(
      {
        sessionTarget: 'one sentence, what kind of application is this',
      },
      {
        sourceContent: 'In one sentence, what kind of application is this workspace? Answer directly from the current coding context.',
      },
      'coding_task',
      'inspect',
      'classifier.primary',
    );

    expect(result.entities.sessionTarget).toBeUndefined();
  });

  it('preserves classifier-provided coding-task session targets when no source content is available', () => {
    const result = resolveIntentGatewayEntities(
      {
        sessionTarget: 'TempInstallTest coding workspace',
      },
      undefined,
      'coding_task',
      'run',
      'classifier.primary',
    );

    expect(result.entities.sessionTarget).toBe('TempInstallTest coding workspace');
  });

  it('preserves the richer explicit coding-task session target when it matches the source-derived workspace', () => {
    const result = resolveIntentGatewayEntities(
      {
        sessionTarget: 'Test Tactical Game App workspace',
      },
      {
        sourceContent: 'Use Codex in the Test Tactical Game App workspace to create a smoke test file.',
      },
      'coding_task',
      'create',
      'classifier.primary',
    );

    expect(result.entities.sessionTarget).toBe('Test Tactical Game App workspace');
    expect(result.provenance?.sessionTarget).toBe('classifier.primary');
  });

  it('keeps classifier-provided session targets for explicit coding-session control requests', () => {
    const result = resolveIntentGatewayEntities(
      {
        sessionTarget: 'Guardian project',
      },
      {
        sourceContent: 'Switch this chat to Guardian project.',
      },
      'coding_session_control',
      'update',
      'classifier.primary',
    );

    expect(result.entities.sessionTarget).toBe('Guardian project');
  });

  it('infers coding-session targets from switch-to-workspace-for phrasing', () => {
    const result = resolveIntentGatewayEntities(
      {},
      { sourceContent: 'Switch this chat to the coding workspace for Temp install test.' },
      'coding_session_control',
      'update',
      'classifier.primary',
    );

    expect(result.entities.sessionTarget).toBe('Temp install test');
    expect(result.provenance).toMatchObject({
      sessionTarget: 'resolver.coding',
    });
  });

  it('infers coding-session list resources when the classifier keeps operation as inspect', () => {
    const result = resolveIntentGatewayEntities(
      {},
      { sourceContent: 'List the coding sessions.' },
      'coding_session_control',
      'inspect',
      'classifier.primary',
    );

    expect(result.entities.codeSessionResource).toBe('session_list');
    expect(result.provenance).toMatchObject({
      codeSessionResource: 'resolver.coding',
    });
  });

  it('preserves remote sandbox commands as coding-task entities', () => {
    expect(resolveIntentGatewayEntities(
      {},
      { sourceContent: 'Run npm test in the remote sandbox for the Guardian workspace.' },
      'coding_task',
      'run',
      'classifier.primary',
    ).entities).toMatchObject({
      command: 'npm test',
      codingRemoteExecRequested: true,
      sessionTarget: 'Guardian',
    });
  });

  it('infers explicit built-in tool names and profile ids for general assistant tool requests', () => {
    const result = resolveIntentGatewayEntities(
      {},
      { sourceContent: 'Run the cloud tool whm_status using profileId social.' },
      'general_assistant',
      'run',
      'classifier.primary',
    );

    expect(result.entities).toMatchObject({
      toolName: 'whm_status',
      profileId: 'social',
    });
    expect(result.provenance).toMatchObject({
      toolName: 'resolver.tool_inventory',
      profileId: 'resolver.tool_inventory',
    });
  });

  it('infers routine filters for personal-assistant reads', () => {
    expect(resolveIntentGatewayEntities(
      {},
      { sourceContent: 'Show only my disabled routines.' },
      'personal_assistant_task',
      'read',
      'classifier.primary',
    ).entities).toMatchObject({
      personalItemType: 'routine',
      enabled: false,
    });
  });

  it('does not infer Second Brain library entities from explicit automation authoring prompts', () => {
    const result = resolveIntentGatewayEntities(
      {},
      {
        sourceContent: 'Create a deterministic scheduled automation named "Example Nav Check". Run it weekdays at 8:30 AM. Use built-in browser tools only to open https://example.com, extract the top navigation links, and notify me in web only when the labels change. Do not create an assistant automation.',
      },
      'personal_assistant_task',
      'update',
      'classifier.primary',
    );

    expect(result.entities.personalItemType).toBeUndefined();
    expect(result.entities.query).toBeUndefined();
  });
});
