interface SkillLike {
  id?: string | null;
}

type AnswerFirstSkillId = 'writing-plans' | 'verification-before-completion' | 'code-review';

function collectSkillIds(skills: readonly SkillLike[]): Set<string> {
  return new Set(
    skills
      .map((skill) => (typeof skill.id === 'string' ? skill.id : ''))
      .filter((skillId) => skillId.length > 0),
  );
}

function selectPrimaryAnswerFirstSkill(
  skillIds: ReadonlySet<string>,
  originalRequest?: string,
): AnswerFirstSkillId | null {
  const normalizedRequest = originalRequest?.trim().toLowerCase() ?? '';
  const looksLikeVerification = /\b(?:verified?|verification|before completion|done and passing|must be verified|claim .* done|full legitimate green|proof surface)\b/.test(normalizedRequest);
  const looksLikeReview = /\bcode review\b/.test(normalizedRequest)
    || /\breview\s+(?:this|the)\s+(?:code|diff|patch|pull request|pr|change|changes)\b/.test(normalizedRequest)
    || /\b(?:do|perform|run)\s+(?:a\s+)?review\b[^.!?\n]{0,120}\b(?:code|diff|patch|pull request|pr|change|changes)\b/.test(normalizedRequest);
  const looksLikePlan = /\b(?:implementation plan|write a plan|plan\b|break this down|before editing|acceptance gates)\b/.test(normalizedRequest);

  if (looksLikeVerification && skillIds.has('verification-before-completion')) {
    return 'verification-before-completion';
  }
  if (looksLikeReview && skillIds.has('code-review')) {
    return 'code-review';
  }
  if (looksLikePlan && skillIds.has('writing-plans')) {
    return 'writing-plans';
  }
  if (normalizedRequest) {
    return null;
  }
  if (skillIds.has('verification-before-completion')) {
    return 'verification-before-completion';
  }
  if (skillIds.has('code-review')) {
    return 'code-review';
  }
  if (skillIds.has('writing-plans')) {
    return 'writing-plans';
  }
  return null;
}

export function shouldUseAnswerFirstForSkills(
  skills: readonly SkillLike[],
  originalRequest?: string,
): boolean {
  const skillIds = collectSkillIds(skills);
  return selectPrimaryAnswerFirstSkill(skillIds, originalRequest) !== null;
}

export function isAnswerFirstSkillResponseSufficient(
  skills: readonly SkillLike[],
  content: string,
  originalRequest?: string,
): boolean {
  const normalized = content.trim();
  if (!normalized || isStructurallyDegradedAnswer(normalized)) {
    return false;
  }

  const skillIds = collectSkillIds(skills);
  const primarySkill = selectPrimaryAnswerFirstSkill(skillIds, originalRequest);

  if (
    primarySkill === 'writing-plans'
    && (
      !/acceptance gates/i.test(normalized)
      || !/existing checks to reuse/i.test(normalized)
    )
  ) {
    return false;
  }

  if (
    primarySkill === 'verification-before-completion'
    && (
      !/full legitimate green/i.test(normalized)
      || !/proof surface/i.test(normalized)
    )
  ) {
    return false;
  }

  return true;
}

function isStructurallyDegradedAnswer(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return true;
  if (/<\/?tool_result\b|<\/?tool_calls?\b|<\/?tool_call\b/i.test(trimmed)) {
    return true;
  }
  if (trimmed.length < 200 && /^\{[\s\S]*\}$/.test(trimmed)) {
    try {
      JSON.parse(trimmed);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function buildAnswerFirstSkillCorrectionPrompt(
  skills: readonly SkillLike[],
  originalRequest: string,
): string | undefined {
  const normalizedRequest = originalRequest.trim();
  const skillIds = collectSkillIds(skills);
  const primarySkill = selectPrimaryAnswerFirstSkill(skillIds, normalizedRequest);
  const lines: string[] = [];

  if (primarySkill === 'writing-plans') {
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

  if (primarySkill === 'verification-before-completion') {
    lines.push('System correction: the Verification Before Completion skill is active for this turn.');
    if (normalizedRequest) {
      lines.push(`Answer this original request directly: "${normalizedRequest}"`);
    }
    lines.push('State that the work still needs full legitimate green before completion.');
    lines.push('Explicitly mention the proof surface that must be verified.');
    lines.push('Use the exact phrases "full legitimate green" and "proof surface" in the answer.');
    lines.push('Do not stop at generic commentary about maybe running a test later.');
  }

  if (primarySkill === 'code-review') {
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
  const skillIds = collectSkillIds(skills);
  const primarySkill = selectPrimaryAnswerFirstSkill(skillIds, normalizedRequest);

  if (primarySkill === 'writing-plans') {
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

  if (primarySkill === 'verification-before-completion') {
    return 'Do not call it done yet. The bar is full legitimate green on the real proof surface, not a weaker subset. Identify the strongest check that proves the claim, run it fresh, read the full result, and only then decide whether the work is complete.';
  }

  if (primarySkill === 'code-review') {
    return [
      'No grounded review findings were produced yet.',
      'A valid code review response needs findings first, ordered by severity, with file references when available.',
      'If no findings remain after inspection, say that explicitly and then note any residual risks or missing tests.',
    ].join(' ');
  }

  return undefined;
}
