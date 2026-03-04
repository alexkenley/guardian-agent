/**
 * Pure admission pipeline logic — no side effects.
 *
 * Extracts the core decision-making from Guardian.check() so it can
 * be tested without mocks or loggers.
 */

import type { AdmissionController, AgentAction } from './guardian.js';

/** Result of running the full admission pipeline. */
export interface AdmissionPipelineResult {
  /** Whether the action passed all controllers. */
  allowed: boolean;
  /** The controller that denied (if denied). */
  controller: string;
  /** Denial reason (if denied). */
  reason?: string;
  /** Mutated action if any mutating controller modified it. */
  mutatedAction?: AgentAction;
}

/**
 * Sort controllers by phase: mutating first, then validating.
 * Returns a new sorted array (does not mutate input).
 */
export function sortControllersByPhase(controllers: readonly AdmissionController[]): AdmissionController[] {
  return [...controllers].sort((a, b) => {
    if (a.phase === 'mutating' && b.phase === 'validating') return -1;
    if (a.phase === 'validating' && b.phase === 'mutating') return 1;
    return 0;
  });
}

/**
 * Run an action through an ordered list of admission controllers.
 *
 * Pure function — no logging or other side effects.
 * Controllers should already be sorted (mutating before validating).
 */
export function runAdmissionPipeline(
  controllers: readonly AdmissionController[],
  action: AgentAction,
): AdmissionPipelineResult {
  let currentAction = action;

  for (const controller of controllers) {
    const result = controller.check(currentAction);
    if (result === null) continue;

    if (!result.allowed) {
      return {
        allowed: false,
        controller: result.controller,
        reason: result.reason,
      };
    }

    // Mutating controller may have modified the action
    if (result.mutatedAction) {
      currentAction = result.mutatedAction;
    }
  }

  return {
    allowed: true,
    controller: 'guardian',
    mutatedAction: currentAction !== action ? currentAction : undefined,
  };
}
