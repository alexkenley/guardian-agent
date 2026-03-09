/**
 * Shadow mode — runs the policy engine alongside the legacy decide()
 * path and compares decisions without affecting execution.
 */

import type {
  PolicyDecisionKind,
  PolicyEngine,
  PolicyInput,
  ShadowComparison,
  MismatchClass,
  PolicyModeConfig,
} from './types.js';

export interface ShadowLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
}

export interface ShadowModeOptions {
  engine: PolicyEngine;
  logger: ShadowLogger;
  /** Maximum mismatches to log before throttling (default: 1000). */
  mismatchLogLimit?: number;
}

/**
 * Shadow mode evaluator. Compares policy engine decisions against
 * legacy decisions and logs mismatches without affecting execution flow.
 */
export class ShadowEvaluator {
  private readonly engine: PolicyEngine;
  private readonly logger: ShadowLogger;
  private readonly mismatchLogLimit: number;

  // Counters
  private totalComparisons = 0;
  private totalMismatches = 0;
  private mismatchesByClass: Record<MismatchClass, number> = {
    policy_too_strict: 0,
    policy_too_permissive: 0,
    normalization_bug: 0,
    legacy_bug: 0,
    unknown: 0,
  };

  constructor(options: ShadowModeOptions) {
    this.engine = options.engine;
    this.logger = options.logger;
    this.mismatchLogLimit = options.mismatchLogLimit ?? 1000;
  }

  /**
   * Compare the legacy decision against the policy engine's decision.
   * Returns the comparison result. Never throws.
   */
  compare(input: PolicyInput, legacyDecision: PolicyDecisionKind): ShadowComparison {
    this.totalComparisons++;

    let policyDecisionKind: PolicyDecisionKind;
    let ruleId: string | undefined;

    try {
      const result = this.engine.evaluate(input);
      policyDecisionKind = result.kind;
      ruleId = result.ruleId;
    } catch {
      // Engine error — treat as unknown mismatch if legacy would have allowed
      policyDecisionKind = 'deny';
      ruleId = undefined;
    }

    const mismatch = legacyDecision !== policyDecisionKind;
    const mismatchClass = mismatch
      ? classifyMismatch(legacyDecision, policyDecisionKind)
      : undefined;

    const comparison: ShadowComparison = {
      family: input.family,
      action: input.action,
      resourceSummary: `${input.resource.kind}:${input.resource.id ?? '(none)'}`,
      legacyDecision,
      policyDecision: policyDecisionKind,
      ruleId,
      mismatch,
      mismatchClass,
    };

    if (mismatch) {
      this.totalMismatches++;
      if (mismatchClass) {
        this.mismatchesByClass[mismatchClass]++;
      }

      if (this.totalMismatches <= this.mismatchLogLimit) {
        this.logger.warn('Policy shadow mismatch', {
          action: comparison.action,
          resource: comparison.resourceSummary,
          legacy: legacyDecision,
          policy: policyDecisionKind,
          ruleId,
          class: mismatchClass,
        });
      } else if (this.totalMismatches === this.mismatchLogLimit + 1) {
        this.logger.warn(`Shadow mismatch log limit reached (${this.mismatchLogLimit}), throttling further logs`);
      }
    }

    return comparison;
  }

  /**
   * Get summary statistics for shadow mode comparisons.
   */
  stats(): ShadowStats {
    return {
      totalComparisons: this.totalComparisons,
      totalMismatches: this.totalMismatches,
      matchRate: this.totalComparisons > 0
        ? (this.totalComparisons - this.totalMismatches) / this.totalComparisons
        : 1,
      mismatchesByClass: { ...this.mismatchesByClass },
    };
  }

  /** Reset all counters. */
  reset(): void {
    this.totalComparisons = 0;
    this.totalMismatches = 0;
    for (const key of Object.keys(this.mismatchesByClass)) {
      this.mismatchesByClass[key as MismatchClass] = 0;
    }
  }
}

export interface ShadowStats {
  totalComparisons: number;
  totalMismatches: number;
  matchRate: number;
  mismatchesByClass: Record<MismatchClass, number>;
}

/**
 * Classify a mismatch between legacy and policy decisions.
 */
function classifyMismatch(
  legacy: PolicyDecisionKind,
  policy: PolicyDecisionKind,
): MismatchClass {
  // Severity ordering: deny(0) > require_approval(1) > allow(2)
  const severity: Record<PolicyDecisionKind, number> = {
    deny: 0,
    require_approval: 1,
    allow: 2,
  };

  const legacySev = severity[legacy];
  const policySev = severity[policy];

  if (policySev < legacySev) {
    // Policy is stricter than legacy
    return 'policy_too_strict';
  }
  if (policySev > legacySev) {
    // Policy is more permissive than legacy
    return 'policy_too_permissive';
  }

  // Same severity but different kind shouldn't happen with 3 kinds,
  // but handle defensively
  return 'unknown';
}

/**
 * Determine whether the policy engine should evaluate for a given family mode.
 */
export function shouldEvaluate(familyMode: PolicyModeConfig): boolean {
  return familyMode === 'shadow' || familyMode === 'enforce';
}

/**
 * Determine whether the policy engine's decision should be authoritative.
 */
export function isEnforcing(familyMode: PolicyModeConfig): boolean {
  return familyMode === 'enforce';
}
