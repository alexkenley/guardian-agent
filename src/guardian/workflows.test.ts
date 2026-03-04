import { describe, it, expect } from 'vitest';
import { runAdmissionPipeline, sortControllersByPhase } from './workflows.js';
import type { AdmissionController, AgentAction } from './guardian.js';

function makeAction(overrides: Partial<AgentAction> = {}): AgentAction {
  return {
    type: 'write_file',
    agentId: 'test-agent',
    capabilities: ['write_files'],
    params: {},
    ...overrides,
  };
}

function makeController(overrides: Partial<AdmissionController> & { name: string; phase: 'mutating' | 'validating' }): AdmissionController {
  return {
    check: () => null,
    ...overrides,
  };
}

describe('sortControllersByPhase', () => {
  it('puts mutating before validating', () => {
    const v = makeController({ name: 'V', phase: 'validating' });
    const m = makeController({ name: 'M', phase: 'mutating' });
    const sorted = sortControllersByPhase([v, m]);
    expect(sorted[0].name).toBe('M');
    expect(sorted[1].name).toBe('V');
  });

  it('preserves order within same phase', () => {
    const v1 = makeController({ name: 'V1', phase: 'validating' });
    const v2 = makeController({ name: 'V2', phase: 'validating' });
    const sorted = sortControllersByPhase([v1, v2]);
    expect(sorted[0].name).toBe('V1');
    expect(sorted[1].name).toBe('V2');
  });

  it('does not mutate the input array', () => {
    const v = makeController({ name: 'V', phase: 'validating' });
    const m = makeController({ name: 'M', phase: 'mutating' });
    const original = [v, m];
    sortControllersByPhase(original);
    expect(original[0]).toBe(v);
  });
});

describe('runAdmissionPipeline', () => {
  it('returns allowed when all controllers pass through (null)', () => {
    const controllers = [
      makeController({ name: 'A', phase: 'validating' }),
      makeController({ name: 'B', phase: 'validating' }),
    ];
    const result = runAdmissionPipeline(controllers, makeAction());
    expect(result.allowed).toBe(true);
    expect(result.controller).toBe('guardian');
    expect(result.mutatedAction).toBeUndefined();
  });

  it('returns denied when a controller denies', () => {
    const controllers = [
      makeController({
        name: 'Denier',
        phase: 'validating',
        check: () => ({ allowed: false, reason: 'no cap', controller: 'Denier' }),
      }),
    ];
    const result = runAdmissionPipeline(controllers, makeAction());
    expect(result.allowed).toBe(false);
    expect(result.controller).toBe('Denier');
    expect(result.reason).toBe('no cap');
  });

  it('stops at first denial', () => {
    let secondCalled = false;
    const controllers = [
      makeController({
        name: 'Denier',
        phase: 'validating',
        check: () => ({ allowed: false, reason: 'blocked', controller: 'Denier' }),
      }),
      makeController({
        name: 'Second',
        phase: 'validating',
        check: () => { secondCalled = true; return null; },
      }),
    ];
    runAdmissionPipeline(controllers, makeAction());
    expect(secondCalled).toBe(false);
  });

  it('propagates mutations from mutating controllers', () => {
    const mutated: AgentAction = { ...makeAction(), params: { sanitized: true } };
    const controllers = [
      makeController({
        name: 'Mutator',
        phase: 'mutating',
        check: () => ({ allowed: true, controller: 'Mutator', mutatedAction: mutated }),
      }),
    ];
    const result = runAdmissionPipeline(controllers, makeAction());
    expect(result.allowed).toBe(true);
    expect(result.mutatedAction).toBe(mutated);
  });

  it('passes mutated action to subsequent controllers', () => {
    const mutated: AgentAction = { ...makeAction(), params: { clean: true } };
    let receivedAction: AgentAction | undefined;
    const controllers = [
      makeController({
        name: 'Mutator',
        phase: 'mutating',
        check: () => ({ allowed: true, controller: 'Mutator', mutatedAction: mutated }),
      }),
      makeController({
        name: 'Validator',
        phase: 'validating',
        check: (action) => { receivedAction = action; return null; },
      }),
    ];
    runAdmissionPipeline(controllers, makeAction());
    expect(receivedAction).toBe(mutated);
  });

  it('handles empty controller list', () => {
    const result = runAdmissionPipeline([], makeAction());
    expect(result.allowed).toBe(true);
  });
});
