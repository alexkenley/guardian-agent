import { isResponseDegraded } from './response-quality.js';

const ANSWER_FIRST_SKILL_IDS = new Set([
  'writing-plans',
  'verification-before-completion',
  'code-review',
]);

interface SkillLike {
  id?: string | null;
}

export function shouldUseAnswerFirstForSkills(skills: readonly SkillLike[]): boolean {
  return skills.some((skill) => (
    typeof skill.id === 'string'
    && ANSWER_FIRST_SKILL_IDS.has(skill.id)
  ));
}

export function isAnswerFirstSkillResponseSufficient(
  skills: readonly SkillLike[],
  content: string,
): boolean {
  const normalized = content.trim();
  if (!normalized || isResponseDegraded(normalized)) {
    return false;
  }

  const skillIds = new Set(
    skills
      .map((skill) => (typeof skill.id === 'string' ? skill.id : ''))
      .filter((skillId) => skillId.length > 0),
  );

  if (
    skillIds.has('writing-plans')
    && (
      !/acceptance gates/i.test(normalized)
      || !/existing checks to reuse/i.test(normalized)
    )
  ) {
    return false;
  }

  if (
    skillIds.has('verification-before-completion')
    && (
      !/full legitimate green/i.test(normalized)
      || !/proof surface/i.test(normalized)
    )
  ) {
    return false;
  }

  return true;
}

export function buildAnswerFirstSkillCorrectionPrompt(
  skills: readonly SkillLike[],
  originalRequest: string,
): string | undefined {
  const normalizedRequest = originalRequest.trim();
  const skillIds = new Set(
    skills
      .map((skill) => (typeof skill.id === 'string' ? skill.id : ''))
      .filter((skillId) => skillId.length > 0),
  );
  const lines: string[] = [];

  if (skillIds.has('writing-plans')) {
    lines.push('System correction: the Writing Plans skill is active for this turn.');
    if (normalizedRequest) {
      lines.push(`Answer this original request directly: "${normalizedRequest}"`);
    }
    lines.push('Your response must include a section titled "Acceptance Gates".');
    lines.push('Your response must include a section titled "Existing Checks To Reuse".');
    lines.push('Do not substitute Goal, Constraints, or generic task lists in place of "Acceptance Gates".');
    lines.push('Use this exact skeleton if you need it: "## Acceptance Gates" followed by bullets, then "## Existing Checks To Reuse" followed by bullets.');
    lines.push('Do not stop at exploration commentary such as "let me inspect" or "good signal".');
    lines.push('If you genuinely need grounding first, use the available repo or skill-reading tools now instead of narrating.');
  }

  if (skillIds.has('verification-before-completion')) {
    lines.push('System correction: the Verification Before Completion skill is active for this turn.');
    if (normalizedRequest) {
      lines.push(`Answer this original request directly: "${normalizedRequest}"`);
    }
    lines.push('State that the work still needs full legitimate green before completion.');
    lines.push('Explicitly mention the proof surface that must be verified.');
    lines.push('Use the exact phrases "full legitimate green" and "proof surface" in the answer.');
    lines.push('Do not stop at generic commentary about maybe running a test later.');
  }

  if (skillIds.has('code-review')) {
    lines.push('System correction: the Code Review skill is active for this turn.');
    if (normalizedRequest) {
      lines.push(`Answer this original request directly: "${normalizedRequest}"`);
    }
    lines.push('Present concrete findings first, ordered by severity, before any summary.');
    lines.push('If there are no findings, say that explicitly and then note any residual risks or missing tests.');
  }

  return lines.length > 0 ? lines.join(' ') : undefined;
}

export function buildAnswerFirstSkillFallbackResponse(
  skills: readonly SkillLike[],
  originalRequest: string,
): string | undefined {
  const normalizedRequest = originalRequest.trim();
  const skillIds = new Set(
    skills
      .map((skill) => (typeof skill.id === 'string' ? skill.id : ''))
      .filter((skillId) => skillId.length > 0),
  );

  if (skillIds.has('writing-plans')) {
    return [
      '# Implementation Plan',
      '',
      '## Goal',
      `- Deliver the requested change: ${normalizedRequest || 'the requested implementation work'}.`,
      '- Keep the scope bounded to the owning runtime, verification, and any affected docs or rollout notes.',
      '',
      '## Acceptance Gates',
      '- The requested behavior works end to end without regressing the current user-facing flow.',
      '- The strongest existing proof surface still passes before the work is called done.',
      '- Any affected persistence, routing, or UI behavior remains coherent after the change.',
      '',
      '## Existing Checks To Reuse',
      '- Inspect and reuse the strongest existing repo, harness, integration, or regression checks before adding narrower tests.',
      '- Prefer the broader proof surface that already exercises the behavior over a weaker mock-only substitute.',
      '',
      '## Files / Areas Affected',
      '- Identify the store, service, routing, and presentation layers that currently own this behavior before editing.',
      '',
      '## Tasks',
      '### Task 1: Ground the change in the existing implementation',
      '- change: locate the owning runtime paths, data model, and any user-facing surfaces for this behavior',
      '- verification: confirm which existing checks already exercise the current flow',
      '',
      '### Task 2: Implement the bounded behavior change',
      '- change: update the owning runtime layer first, then any caller or UI surface that depends on it',
      '- verification: prove the requested behavior works without regressing adjacent flows',
      '',
      '### Task 3: Lock in verification and follow-through',
      '- change: extend or add the narrowest extra coverage only after reusing the strongest existing checks',
      '- verification: run the broader proof surface before declaring completion',
      '',
      '## Risks / Open Questions',
      '- Confirm any archive/delete/disable semantics before implementation if multiple lifecycle states already exist.',
      '- Confirm whether background jobs, notifications, or dashboards also need to respect the new behavior.',
    ].join('\n');
  }

  if (skillIds.has('verification-before-completion')) {
    return 'Do not call it done yet. The bar is full legitimate green on the real proof surface, not a weaker subset. Identify the strongest check that proves the claim, run it fresh, read the full result, and only then decide whether the work is complete.';
  }

  if (skillIds.has('code-review')) {
    return [
      'No grounded review findings were produced yet.',
      'A valid code review response needs findings first, ordered by severity, with file references when available.',
      'If no findings remain after inspection, say that explicitly and then note any residual risks or missing tests.',
    ].join(' ');
  }

  return undefined;
}
