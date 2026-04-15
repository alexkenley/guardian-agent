import { describe, expect, it } from 'vitest';
import { resolveIntentGatewayEntities } from './route-entity-resolution.js';

describe('resolveIntentGatewayEntities', () => {
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
