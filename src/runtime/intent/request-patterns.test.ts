import { describe, expect, it } from 'vitest';

import {
  isExplicitComplexPlanningRequest,
  isExplicitCodingSessionControlRequest,
  isExplicitRepoInspectionRequest,
  isExplicitWorkspaceScopedRepoWorkRequest,
  isConversationTranscriptReferenceRequest,
  looksLikePendingActionContextTurn,
} from './request-patterns.js';

describe('request-patterns', () => {
  it('recognizes malformed explicit complex-planning cue text that still names the planner path for this request', () => {
    expect(isExplicitComplexPlanningRequest(
      'se your complex-planning path for this request. In tmp/manual-dag-smoke-2, create notes.txt.',
    )).toBe(true);
  });

  it('does not treat explanatory mentions of the planner path as explicit execution requests', () => {
    expect(isExplicitComplexPlanningRequest(
      'Explain how the complex-planning path works.',
    )).toBe(false);
  });

  it('detects turns that should keep pending approval context attached', () => {
    expect(looksLikePendingActionContextTurn('Can you use Claude Code instead?')).toBe(true);
    expect(looksLikePendingActionContextTurn('What pending approvals do I have right now?')).toBe(true);
    expect(looksLikePendingActionContextTurn('What happened to that last request?')).toBe(true);
  });

  it('does not treat unrelated fresh text as pending approval follow-up context', () => {
    expect(looksLikePendingActionContextTurn('Hiroshima')).toBe(false);
  });

  it('recognizes explicit repo inspection requests that should stay in coding_task', () => {
    expect(isExplicitRepoInspectionRequest(
      'Inspect this repo and tell me which files implement delegated worker progress and run timeline rendering. Do not edit anything.',
    )).toBe(true);
    expect(isExplicitRepoInspectionRequest(
      'Search the repo for answerValue and tell me where it is defined.',
    )).toBe(true);
  });

  it('does not confuse session-attachment questions with repo inspection requests', () => {
    expect(isExplicitRepoInspectionRequest(
      'What coding workspace is this chat currently attached to?',
    )).toBe(false);
    expect(isExplicitRepoInspectionRequest(
      'Using the very first answer in this chat, give me a 5-bullet handoff note for another engineer. Do not re-search the repo.',
    )).toBe(false);
  });

  it('recognizes explicit coding-session control requests without confusing them for repo work', () => {
    expect(isExplicitCodingSessionControlRequest(
      'What coding workspace is this chat currently attached to?',
    )).toBe(true);
    expect(isExplicitCodingSessionControlRequest(
      'Switch this chat to the coding workspace for Temp install test.',
    )).toBe(true);
    expect(isExplicitCodingSessionControlRequest(
      'Inspect this repo and tell me which files implement delegated worker progress and run timeline rendering. Do not edit anything.',
    )).toBe(false);
    expect(isExplicitCodingSessionControlRequest(
      'Use Codex in the Test Tactical Game App coding workspace to create test-switch-a in the top-level directory.',
    )).toBe(false);
  });

  it('recognizes explicit workspace-scoped repo work without treating it as session management', () => {
    expect(isExplicitWorkspaceScopedRepoWorkRequest(
      'Use Codex in the Test Tactical Game App coding workspace to create test-switch-a in the top-level directory.',
    )).toBe(true);
    expect(isExplicitWorkspaceScopedRepoWorkRequest(
      'Create README.md in the Guardian workspace.',
    )).toBe(true);
    expect(isExplicitWorkspaceScopedRepoWorkRequest(
      'Inspect the Guardian workspace and tell me what matters most.',
    )).toBe(false);
  });

  it('recognizes requests that explicitly refer back to the chat transcript', () => {
    expect(isConversationTranscriptReferenceRequest(
      'Using the very first answer in this chat, give me a 5-bullet handoff note for another engineer.',
    )).toBe(true);
    expect(isConversationTranscriptReferenceRequest(
      'Did the last answer in this conversation use the same delegated model profile?',
    )).toBe(true);
  });
});
