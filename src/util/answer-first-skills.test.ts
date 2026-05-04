import { describe, expect, it } from 'vitest';

import {
  buildAnswerFirstSkillFallbackResponse,
  isAnswerFirstSkillResponseSufficient,
  shouldUseAnswerFirstForSkills,
} from './answer-first-skills.js';

const mixedSkills = [
  { id: 'verification-before-completion' },
  { id: 'writing-plans' },
];

describe('answer-first skill prioritization', () => {
  it('prefers the verification contract when the request is about proving completion', () => {
    const request = 'We are about to claim this fix is done and passing. What must be verified before completion?';
    const response = 'Do not call it done yet. You need full legitimate green on the real proof surface before completion.';

    expect(isAnswerFirstSkillResponseSufficient(mixedSkills, response, request)).toBe(true);
    expect(buildAnswerFirstSkillFallbackResponse(mixedSkills, request)).toContain('full legitimate green');
    expect(buildAnswerFirstSkillFallbackResponse(mixedSkills, request)).toContain('proof surface');
  });

  it('prefers the writing plan contract when the request explicitly asks for a plan', () => {
    const request = 'Write an implementation plan for adding archived routines to this app. Break this down before editing anything.';
    const fallback = buildAnswerFirstSkillFallbackResponse(mixedSkills, request);

    expect(fallback).toContain('# Implementation Plan');
    expect(fallback).toContain('Acceptance Gates');
    expect(fallback).toContain('Existing Checks To Reuse');
  });

  it('does not activate the code-review answer-first contract for plain repo inspection requests', () => {
    const request = 'Inspect this repo and tell me which files implement delegated worker progress and run timeline rendering.';
    const skills = [
      { id: 'coding-workspace' },
      { id: 'code-review' },
    ];

    expect(shouldUseAnswerFirstForSkills(skills, request)).toBe(false);
    expect(buildAnswerFirstSkillFallbackResponse(skills, request)).toBeUndefined();
  });

  it('does not activate the code-review answer-first contract for trace inspection requests', () => {
    const request = 'Review the recent routing trace for the last failed assistant request and explain what happened.';
    const skills = [
      { id: 'coding-workspace' },
      { id: 'code-review' },
    ];

    expect(shouldUseAnswerFirstForSkills(skills, request)).toBe(false);
    expect(buildAnswerFirstSkillFallbackResponse(skills, request)).toBeUndefined();
  });

  it('still activates the code-review answer-first contract for patch review requests', () => {
    const request = 'Review this patch for regressions and missing tests before merge.';
    const skills = [
      { id: 'coding-workspace' },
      { id: 'code-review' },
    ];

    expect(shouldUseAnswerFirstForSkills(skills, request)).toBe(true);
    expect(buildAnswerFirstSkillFallbackResponse(skills, request)).toContain('review findings');
  });
});
