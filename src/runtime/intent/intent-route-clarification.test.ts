import { describe, expect, it } from 'vitest';

import { deriveIntentRouteClarification } from './intent-route-clarification.js';

describe('intent-route-clarification', () => {
  it('asks for coding-scope confirmation when a turn mixes workspace/session and repo-work signals', () => {
    expect(deriveIntentRouteClarification({
      content: 'Inspect the Guardian workspace and tell me what matters most.',
      decision: {
        route: 'coding_session_control',
        confidence: 'medium',
        turnRelation: 'new_request',
      },
      mode: 'route_only_fallback',
    })).toMatchObject({
      candidateRoutes: ['coding_task', 'coding_session_control'],
      options: [
        { value: 'coding_task', label: 'Repo work' },
        { value: 'coding_session_control', label: 'Workspace/session control' },
      ],
    });
  });

  it('does not ask for coding-scope confirmation when the repo-work intent is explicit', () => {
    expect(deriveIntentRouteClarification({
      content: 'Inspect this repo and tell me which files implement delegated worker progress and run timeline rendering. Do not edit anything.',
      decision: {
        route: 'coding_session_control',
        confidence: 'low',
        turnRelation: 'new_request',
      },
      mode: 'route_only_fallback',
    })).toBeNull();
  });

  it('does not ask for coding-scope confirmation when the request does concrete repo work inside a named workspace', () => {
    expect(deriveIntentRouteClarification({
      content: 'Use Codex in the Test Tactical Game App coding workspace to create test-switch-a in the top-level directory.',
      decision: {
        route: 'coding_session_control',
        confidence: 'low',
        turnRelation: 'new_request',
      },
      mode: 'route_only_fallback',
    })).toBeNull();
  });

  it('does not ask for coding-scope confirmation when the request explicitly searches the workspace repo', () => {
    expect(deriveIntentRouteClarification({
      content: 'Search the workspace for answerValue and tell me where it is defined.',
      decision: {
        route: 'coding_session_control',
        confidence: 'low',
        turnRelation: 'new_request',
      },
      mode: 'route_only_fallback',
    })).toBeNull();
  });

  it('asks for automation confirmation when create-vs-update intent is ambiguous', () => {
    expect(deriveIntentRouteClarification({
      content: 'Can you create or update the inbox automation for me?',
      decision: {
        route: 'automation_control',
        confidence: 'medium',
        turnRelation: 'new_request',
      },
      mode: 'primary',
    })).toMatchObject({
      candidateRoutes: ['automation_authoring', 'automation_control'],
      options: [
        { value: 'automation_authoring', label: 'Create new automation' },
        { value: 'automation_control', label: 'Edit existing automation' },
      ],
    });
  });

  it('asks whether an ambiguous page request is Guardian UI or the web', () => {
    expect(deriveIntentRouteClarification({
      content: 'Open the dashboard page for me.',
      decision: {
        route: 'browser_task',
        confidence: 'low',
        turnRelation: 'new_request',
      },
      mode: 'route_only_fallback',
    })).toMatchObject({
      candidateRoutes: ['ui_control', 'browser_task'],
      options: [
        { value: 'ui_control', label: 'Guardian page' },
        { value: 'browser_task', label: 'External website' },
      ],
    });
  });
});
